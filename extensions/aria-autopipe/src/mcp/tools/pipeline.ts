/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDefinition, textResult, errorResult } from './types';
import { services } from '../../common/services';
import { workspacePathsFor, Pipeline } from '../../common/types';
import { parseGithubUrl, fetchGithubLogin, fetchGithubFile, fetchPipelineCodeDump, fillRoCrateAuthor } from '../../common/githubApi';
import { parseRoCrateMetadata, cleanContent, normalizePaths, shellEscape } from '../../common/roCrate';
import { windowsToWsl } from '../../common/dockerEnv';

// Pipeline registry / publishing tools. Hub-side operations
// (search/list/download/upload/publish/unpublish) stay as informational
// placeholders for now — those land when the Hub UI ships. Local-side
// operations (validate, delete) are wired through SSH.

const HUB_STUB = (toolName: string, args: Record<string, unknown>) =>
	textResult(`[${toolName}] not yet wired — the Autopipe Hub UI in Aria is intentionally out of scope for the current build. Arguments received: ${JSON.stringify(args)}`);

function requireProfile() {
	const { config } = services();
	const profile = config.activeProfile();
	if (!profile) {
		throw new Error('No active SSH profile. Configure one via Aria → Autopipe → SSH.');
	}
	return profile;
}

function q(s: string): string {
	if (/^[A-Za-z0-9_./@:+,=-]+$/.test(s)) {
		return s;
	}
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Pretty-print a Hub pipeline list for the AI. Includes id, name,
 *  version, author, GitHub URL and a one-line description per entry. */
function formatPipelineList(pipelines: Pipeline[], header: string): string {
	if (!pipelines || pipelines.length === 0) {
		return `${header}\n\n(none)`;
	}
	const rows = pipelines.map(p => {
		const meta = [
			`id ${p.pipeline_id}`,
			`v${p.version ?? '?'}`,
			p.author ? `@${p.author}` : '',
			p.verified ? 'verified' : '',
		].filter(Boolean).join(' · ');
		const tags = (p.tags ?? []).join(', ');
		return [
			`  ${p.name}  (${meta})`,
			`    ${p.description ?? '(no description)'}`,
			tags ? `    tags: ${tags}` : '',
			p.github_url ? `    github: ${p.github_url}` : '',
		].filter(Boolean).join('\n');
	});
	return [header, '', ...rows].join('\n');
}

/** Convert Hub's `tree/<ref>[/sub]` style GitHub URL into a plain
 *  clonable HTTPS URL (no path inside the repo, no ref). */
function githubCloneUrl(treeUrl: string): string {
	const m = treeUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/|$)/);
	if (!m) {
		throw new Error(`Unrecognized GitHub URL: ${treeUrl}`);
	}
	return `https://github.com/${m[1]}/${m[2]}.git`;
}

/** Tag/branch ref encoded in the Hub URL (`tree/<ref>`). Defaults to
 *  `main` when the URL is just `https://github.com/owner/repo`. */
function extractGitHubRef(treeUrl: string): string {
	const m = treeUrl.match(/\/tree\/([^/?#]+)/);
	return m ? m[1] : 'main';
}

/** Sub-path within the repo, if the URL points into a monorepo
 *  pipeline (`/tree/<ref>/<sub/path>`). Empty string for root. */
function extractGitHubSubPath(treeUrl: string): string {
	const m = treeUrl.match(/\/tree\/[^/?#]+\/(.+)$/);
	return m ? m[1].replace(/\/+$/, '') : '';
}

/** Look up the authenticated GitHub user when we don't already have it
 *  cached in config — needed to build the owner/repo URL during upload. */
async function fetchGithubLogin(token: string): Promise<string> {
	const res = await fetch('https://api.github.com/user', {
		headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
	});
	if (!res.ok) {
		throw new Error(`/user lookup failed (${res.status})`);
	}
	const data = await res.json() as { login?: string };
	if (!data.login) {
		throw new Error('/user response had no login field');
	}
	return data.login;
}

export const PIPELINE_TOOLS: ToolDefinition[] = [
	{
		name: 'search_pipelines',
		description: 'Search pipelines by keyword in the Autopipe Hub registry (name, description, tags).',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search keyword' },
			},
			required: ['query'],
		},
		handler: async (args) => {
			try {
				const query = String(args.query ?? '').trim();
				if (!query) {
					return errorResult('search_pipelines: `query` is required');
				}
				const results = await services().hub.searchPipelines(query);
				return textResult(formatPipelineList(results, `Search "${query}" — ${results.length} result(s):`));
			} catch (err) {
				return errorResult(`search_pipelines failed: ${(err as Error).message}`);
			}
		},
	},
	{
		name: 'list_pipelines',
		description: 'List all pipelines in the Autopipe Hub registry. Returns id, name, version, author, description, tags, and GitHub URL for each.',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => {
			try {
				const results = await services().hub.listPipelines();
				return textResult(formatPipelineList(results, `Hub has ${results.length} pipeline(s):`));
			} catch (err) {
				return errorResult(`list_pipelines failed: ${(err as Error).message}`);
			}
		},
	},
	{
		name: 'download_pipeline',
		description: "Download a pipeline by ID from the registry to the remote SSH server. Fetches pipeline files from its GitHub repository. If output_dir is omitted, saves to the configured pipelines directory.\n\n"
			+ "MANDATORY — SECURITY REVIEW BEFORE DOWNLOAD (two-call protocol):\n"
			+ "First call (without user_reviewed_warnings=true): this tool fetches every code/config file from the pipeline's GitHub repository (Snakefile, Dockerfile, *.py, *.R, *.sh, *.yaml, *.json, *.md, scripts/*, etc.) and returns them inline as a code dump. It does NOT save anything to the remote server. You MUST silently review every file in the dump for suspicious patterns — overly permissive permissions (chmod 777, SUID/SGID), credentials or tokens hard-coded in source, unexpected outbound network calls, obfuscated or base64-decoded execution, mounting host paths beyond the workspace, --network host or --privileged docker flags, executing remotely fetched scripts without verification, deleting files outside the pipeline workspace, etc. Use your judgement — the goal is to find anything that could harm the user if they run this pipeline.\n"
			+ "Second call (with user_reviewed_warnings=true): performs the actual download to the SSH server. Only call with this flag set when EITHER (a) you found no concerns in the review, OR (b) the user has explicitly confirmed they want to download despite the findings you presented. NEVER skip the review by calling with user_reviewed_warnings=true straight away.\n"
			+ "If you find concerns, present them to the user IN THEIR LANGUAGE: for each finding show (1) the file path and line number, (2) the offending code snippet, (3) a plain-English explanation of the risk (translated to the user's chat language). Then ask: 'Mark all of this code as safe and download anyway?' (or the equivalent in the user's language). Wait for an explicit yes/no per pipeline.\n"
			+ "This review is REQUIRED EVERY TIME, even for the same pipeline downloaded again later — never skip it just because you remember a previous approval.\n\n"
			+ "FALLBACK ON CLONE FAILURE:\n"
			+ "If the second call returns a clone-failure error while the SSH connection is still healthy, you may recover by writing each file individually with write_file, using the code dump returned by the first call. This avoids requiring the user to install or authenticate any additional tooling on the server. Use this fallback before asking the user to log in to GitHub, unless the error message explicitly indicates a private repository.",
		inputSchema: {
			type: 'object',
			properties: {
				pipeline_id: { type: 'integer', description: 'Pipeline ID to download' },
				output_dir: { type: 'string', description: 'Remote directory path (optional, defaults to configured pipelines directory)' },
				user_reviewed_warnings: { type: 'boolean', description: 'Set to true ONLY after the AI has reviewed the pipeline source dump returned by the FIRST call and the user has explicitly approved.' },
			},
			required: ['pipeline_id'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const cfg = services().config.get();
				const { ssh, hub } = services();

				const pipelineId = Number(args.pipeline_id);
				if (!Number.isInteger(pipelineId)) {
					return errorResult('download_pipeline: `pipeline_id` must be an integer.');
				}

				// 1. Hub lookup
				let pipeline;
				try {
					pipeline = await hub.getPipeline(pipelineId);
				} catch (err) {
					return errorResult(`Failed to get pipeline: ${(err as Error).message}`);
				}

				// 2. Parse GitHub URL
				const parsed = parseGithubUrl(pipeline.github_url);
				if (!parsed) {
					return errorResult(`Invalid GitHub URL: ${pipeline.github_url}`);
				}
				const { owner, repo, branch: branchOpt, path: subpath } = parsed;
				const branch = branchOpt ?? 'main';

				// 3. First-call review: return the code dump for AI inspection.
				const userReviewed = args.user_reviewed_warnings === true;
				if (!userReviewed) {
					const token = cfg.github?.token ?? null;
					const reviewRef = pipeline.git_tag ?? branch;
					try {
						const dump = await fetchPipelineCodeDump(owner, repo, reviewRef, subpath, token);
						return textResult(dump);
					} catch (err) {
						return errorResult(`Failed to fetch pipeline source for review: ${(err as Error).message}`);
					}
				}

				// 4. Determine target directory; translate any Windows-style
				//    output_dir to WSL form.
				const baseDir = args.output_dir
					? windowsToWsl(String(args.output_dir))
					: workspacePathsFor(profile).pipelines_dir;
				const dir = `${baseDir.replace(/\/+$/, '')}/${pipeline.name}`;

				const mkdir = await ssh.run(profile, `mkdir -p '${shellEscape(dir)}'`);
				if (mkdir.exitCode !== 0) {
					return errorResult(`Cannot create directory '${dir}': ${mkdir.stdout.trim() || mkdir.stderr.trim()}`);
				}

				// 5. Clone the repo. Try anonymous git clone first; on
				//    failure clean up and try `gh repo clone` (covers
				//    private repos when our token is set).
				const githubToken = cfg.github?.token && cfg.github.token.length > 0 ? cfg.github.token : null;
				const tmpDir = `/tmp/autopipe-clone-${process.pid}`;
				const branchFlag = pipeline.git_tag
					? `--branch '${pipeline.git_tag.replace(/'/g, "'\\''")}' `
					: '';

				const gitClone = await ssh.run(
					profile,
					`git clone --depth 1 ${branchFlag}https://github.com/${owner}/${repo}.git '${tmpDir}'`,
					{ timeoutMs: 300000 },
				);

				let cloneOutput = gitClone.stdout + (gitClone.stderr ? '\n' + gitClone.stderr : '');
				let cloneCode = gitClone.exitCode;
				if (cloneCode !== 0) {
					await ssh.run(profile, `rm -rf '${shellEscape(tmpDir)}'`);
					const pinFlag = pipeline.git_tag
						? ` -- --branch '${pipeline.git_tag.replace(/'/g, "'\\''")}'`
						: '';
					const ghCmd = githubToken
						? `GH_TOKEN='${githubToken}' gh repo clone ${owner}/${repo} '${tmpDir}'${pinFlag}`
						: `gh repo clone ${owner}/${repo} '${tmpDir}'${pinFlag}`;
					const ghRes = await ssh.run(profile, ghCmd, { timeoutMs: 300000 });
					if (ghRes.exitCode !== 0) {
						await ssh.run(profile, `rm -rf '${shellEscape(tmpDir)}'`);
						const combinedOut = (ghRes.stdout + ghRes.stderr).trim()
							? ghRes.stdout + (ghRes.stderr ? '\n' + ghRes.stderr : '')
							: cloneOutput;
						cloneOutput = combinedOut;
						cloneCode = Math.max(ghRes.exitCode, cloneCode);
					} else {
						cloneOutput = ghRes.stdout;
						cloneCode = 0;
					}
				}

				if (cloneCode !== 0) {
					let msg: string;
					if (/could not read Username|Authentication failed|terminal prompts disabled/.test(cloneOutput)) {
						msg = "Repository may be private. Connect GitHub in the Aria Autopipe panel's GitHub section and retry.";
					} else if (/Repository not found|not found|does not exist/.test(cloneOutput)) {
						msg = 'Repository not found on GitHub. Verify the pipeline ID.';
					} else if (cloneOutput.includes('Could not resolve host')) {
						msg = 'Cannot reach github.com from the SSH server. Check network connectivity.';
					} else if (cloneOutput.includes('command not found')) {
						msg = 'git is not installed on the SSH server. Install git and retry.';
					} else {
						msg = cloneOutput;
					}
					return errorResult(`Failed to clone repository: ${msg}`);
				}

				// 6. Move files from sub-path (if any) into target dir.
				const source = subpath ? `${tmpDir}/${subpath}` : tmpDir;
				const moveCmd = `cp -r '${shellEscape(source)}'/* '${shellEscape(dir)}' 2>/dev/null; cp -r '${shellEscape(source)}'/.* '${shellEscape(dir)}' 2>/dev/null; rm -rf '${shellEscape(tmpDir)}'`;
				try {
					await ssh.run(profile, moveCmd);
				} catch (err) {
					await ssh.run(profile, `rm -rf '${shellEscape(tmpDir)}'`);
					return errorResult(`Failed to move files: ${(err as Error).message}`);
				}

				// 7. List downloaded files
				let fileList = '(unable to list files)';
				const listRes = await ssh.run(
					profile,
					`find '${shellEscape(dir)}' -type f -not -path '*/.git/*' | sed 's|${shellEscape(dir)}/||'`,
				);
				if (listRes.exitCode === 0) {
					fileList = listRes.stdout.trim();
				}

				// 8. Clean up .git
				await ssh.run(profile, `rm -rf '${shellEscape(dir)}/.git'`);

				// 9. Inject isBasedOn into ro-crate-metadata.json so later
				//    publishes can record forked_from automatically.
				const metaPath = `${dir}/ro-crate-metadata.json`;
				const hubUrl = `${cfg.registry_url.replace(/\/+$/, '')}/pipelines/${pipelineId}`;
				try {
					const metaRaw = await ssh.readFile(profile, metaPath);
					const cleaned = cleanContent(metaRaw.toString('utf8'));
					const data = JSON.parse(cleaned);
					const graph = data['@graph'];
					if (Array.isArray(graph)) {
						for (const node of graph) {
							if (node && node['@id'] === './') {
								node.isBasedOn = { '@id': hubUrl };
								break;
							}
						}
					}
					const updated = JSON.stringify(data, null, 2);
					await ssh.writeFile(profile, metaPath, updated);
				} catch {
					// best-effort — review/move already succeeded
				}

				const fileCount = fileList.split('\n').filter(l => l.length > 0).length;
				return textResult([
					`Downloaded pipeline '${pipeline.name}' to ${dir} (remote server)`,
					`Files (${fileCount}):`,
					fileList,
				].join('\n'));
			} catch (err) {
				return errorResult(`download_pipeline failed: ${(err as Error).message}`);
			}
		},
	},
	{
		name: 'upload_pipeline',
		description: "Upload a pipeline to GitHub. This only pushes code — versioning and tagging happen during publish_pipeline. After this tool succeeds, you MUST call publish_pipeline with the returned github_url to publish to the registry — unless the user explicitly said 'upload to GitHub only'. IMPORTANT: You MUST provide a complete list of ALL files needed to run the pipeline in the 'files' parameter. Include every file you created: Snakefile, Dockerfile, config.yaml, ro-crate-metadata.json, README.md, and any additional files such as scripts/*.py, requirements.txt, .dockerignore, etc. Do NOT omit any file — if the pipeline needs it to run, it must be in the list. REQUIRES GITHUB: If this tool returns a GitHub-login error, tell the user to open the AutoPipe app, connect GitHub from the GitHub panel, and try again. No restart is needed. REPO MODE: Call get_workspace_info first to see the upload mode. If 'single repo' mode, do NOT ask for a repo name — files go to the configured repository under pipelines/ subdirectory. If 'per-pipeline repo' mode, ask the user for a repository name and pass it as repo_name. CRITICAL — PIPELINE NAME RULE: The pipeline name is read from `ro-crate-metadata.json` -> `@graph[@id=='./']` -> `name` field. The GitHub directory path is `pipelines/<that name>/`, and the registry will register under that exact name. If the user asks to publish under a DIFFERENT name from the existing pipeline (e.g., 'publish this as test instead of aptaselect'), you MUST: (1) edit `ro-crate-metadata.json` in pipeline_dir to set `name` to the new value BEFORE calling this tool, (2) verify by reading the file back, (3) only then call upload_pipeline. Failing to update ro-crate FIRST will cause the registry to register under the old name, creating a duplicate version of the wrong pipeline. NEVER trust the in-memory pipeline name from a previous load_pipeline / download_pipeline call — always read the ro-crate file fresh from pipeline_dir. DIRECTORY CONFLICT: If the upload target already contains pipeline files, this tool returns (as a normal success result) guidance describing a conflict — this is NOT a completed upload; treat it as a HARD STOP and do not act automatically. You MUST tell the user (in their language) that a repository/location with this name already contains pipeline files and that uploading on top of them can mix the two and produce an INCOMPLETE or BROKEN pipeline, then ask them to choose: change the repository name (per-pipeline mode) or the pipeline name (single-repo mode), OR upload as-is. You MUST NOT set confirm_overwrite=true on your own or in the same turn — only after the user explicitly chooses 'upload as-is' may you re-call with confirm_overwrite=true. Do NOT mention the Hub or its registry status to the user; it is not relevant to them.",
		inputSchema: {
			type: 'object',
			properties: {
				pipeline_dir: { type: 'string', description: 'Remote path to the pipeline directory on the SSH server' },
				files: {
					type: 'array',
					description: 'List of file paths relative to pipeline_dir that are required to run the pipeline.',
					items: { type: 'string' },
				},
				repo_name: { type: 'string', description: 'GitHub repository name (per-pipeline mode only). Omit in single-repo mode.' },
				confirm_overwrite: { type: 'boolean', description: 'Only set to true after the user explicitly chose "upload as-is" in response to a directory-conflict warning.' },
			},
			required: ['pipeline_dir', 'files'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const cfg = services().config.get();
				const { ssh } = services();
				const token = cfg.github?.token;
				if (!token) {
					return errorResult('GitHub login is required. Please open the Autopipe panel, connect GitHub from the GitHub section, and try again.');
				}

				const pipelineDirIn = String(args.pipeline_dir ?? '');
				if (!pipelineDirIn) {
					return errorResult('upload_pipeline: `pipeline_dir` is required');
				}
				const dir = windowsToWsl(pipelineDirIn);

				// Ensure ro-crate-metadata.json is always included
				const files = (Array.isArray(args.files) ? args.files.map(String) : []).slice();
				if (!files.includes('ro-crate-metadata.json')) {
					files.push('ro-crate-metadata.json');
				}
				if (files.length === 0) {
					return errorResult('upload_pipeline: `files` must list every file the pipeline needs.');
				}

				// Read ro-crate-metadata.json (required for pipeline name)
				let metaRawBuffer: Buffer;
				try {
					metaRawBuffer = await ssh.readFile(profile, `${dir}/ro-crate-metadata.json`);
				} catch (err) {
					return errorResult(`Cannot read ro-crate-metadata.json: ${(err as Error).message}`);
				}
				const cleanedMeta = cleanContent(metaRawBuffer.toString('utf8'));
				let metadata;
				try {
					metadata = parseRoCrateMetadata(cleanedMeta);
				} catch (err) {
					return errorResult(`Invalid ro-crate-metadata.json: ${(err as Error).message}`);
				}
				let metadataJsonStr = '';
				try {
					metadataJsonStr = JSON.stringify(JSON.parse(cleanedMeta), null, 2);
				} catch { /* keep empty */ }

				const pipelineName = metadata.name;
				const perPipeline = cfg.per_pipeline_repo !== false;
				let repoName: string;
				let pathPrefix: string;
				if (perPipeline) {
					if (!args.repo_name) {
						return errorResult('Per-pipeline repo mode is enabled but no repo_name provided. Ask the user for a repository name.');
					}
					repoName = String(args.repo_name);
					pathPrefix = '';
				} else {
					repoName = cfg.github_repo;
					if (!repoName) {
						return errorResult('Single-repo mode is enabled but github_repo is unset. Configure it in the Autopipe panel → Pipeline upload mode.');
					}
					pathPrefix = `pipelines/${pipelineName}/`;
				}

				// 1. Get GitHub username
				const userResp = await fetch('https://api.github.com/user', {
					headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe' },
				});
				const userBody = await userResp.json() as { login?: string };
				const owner = typeof userBody.login === 'string' ? userBody.login : '';

				// 2. Ensure repo exists
				const repoCheck = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
					headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe' },
				});
				let repoJustCreated = false;
				if (repoCheck.status === 404) {
					const create = await fetch('https://api.github.com/user/repos', {
						method: 'POST',
						headers: {
							'Authorization': `Bearer ${token}`,
							'User-Agent': 'aria-autopipe',
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({ name: repoName, description: 'AutoPipe pipelines', auto_init: true }),
					});
					if (!create.ok) {
						const errText = await create.text();
						return errorResult(`Failed to create GitHub repo: ${errText}`);
					}
					repoJustCreated = true;
					await new Promise(r => setTimeout(r, 2000));
				}

				// Directory-conflict check
				const registryUrl = cfg.registry_url.replace(/\/+$/, '');
				const dirPrefix = pathPrefix.replace(/\/+$/, '');
				if (!repoJustCreated) {
					try {
						const treeResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/trees/main?recursive=1`, {
							headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe' },
						});
						if (treeResp.ok) {
							const treeBody = await treeResp.json() as { tree?: Array<{ path?: string; type?: string }> };
							const entries = treeBody.tree ?? [];
							const hasMarker = (fname: string) => {
								const target = dirPrefix ? `${dirPrefix}/${fname}` : fname;
								return entries.some(e => e.type === 'blob' && e.path === target);
							};
							const dirExists = hasMarker('Snakefile') || hasMarker('ro-crate-metadata.json');
							if (dirExists) {
								let hasHubRecord = false;
								try {
									const listResp = await fetch(`${registryUrl}/api/pipelines`);
									if (listResp.ok) {
										const list = await listResp.json() as Array<Record<string, unknown>>;
										hasHubRecord = list.some(p => p.name === pipelineName && p.author === owner);
									}
								} catch { /* best-effort */ }
								if (!hasHubRecord && args.confirm_overwrite !== true) {
									const thing = dirPrefix
										? `The directory \`${dirPrefix}/\` in \`${owner}/${repoName}\``
										: `A GitHub repository named \`${repoName}\``;
									const choice = dirPrefix ? 'pipeline name' : 'repository name';
									const changeHow = dirPrefix
										? 'change the `name` field in ro-crate-metadata.json (the dataset node with @id "./") to a unique name and retry'
										: 'ask the user for a new repository name and call upload_pipeline again with that repo_name';
									return textResult(
										`ACTION REQUIRED — NOT UPLOADED YET. This is a HARD STOP: do NOT call upload_pipeline with confirm_overwrite=true on your own or in the same turn. You MUST ask the user first and act on their explicit choice.\n\n`
										+ `${thing} already contains pipeline files. Tell the user, in their language, and ask them to choose — for example: "A ${choice} with this name already contains pipeline files. If you upload your pipeline on top of them, it can get mixed with the existing files and end up incomplete or broken. We recommend using a different ${choice}. Would you like to change the ${choice}, or upload here as-is?"\n\n`
										+ `- If the user wants to change it: ${changeHow} (do NOT set confirm_overwrite).\n`
										+ '- If the user wants to upload as-is: call upload_pipeline again with confirm_overwrite=true.\n\n'
										+ 'Do NOT mention the Hub or its registry status to the user — it is not relevant to them.',
									);
								}
							}
						}
					} catch { /* tree fetch best-effort */ }
				}

				// Read every declared file from SSH, cleaning/normalising per type.
				const fileContents: Array<[string, string]> = [];
				for (const filePath of files) {
					const remotePath = `${dir}/${filePath}`;
					let buf: Buffer;
					try {
						buf = await ssh.readFile(profile, remotePath);
					} catch (err) {
						return errorResult(`Cannot read '${filePath}': ${(err as Error).message}`);
					}
					const content = buf.toString('utf8');
					let cleaned: string;
					if (filePath === 'ro-crate-metadata.json') {
						cleaned = metadataJsonStr;
					} else if (filePath === 'Snakefile' || filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
						cleaned = normalizePaths(cleanContent(content));
					} else {
						cleaned = cleanContent(content);
					}
					fileContents.push([filePath, cleaned]);
				}

				// 3. Get latest commit SHA on main branch (retry up to 5 times for new repos)
				let latestSha = '';
				for (let attempt = 0; attempt < 5; attempt++) {
					const refResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/main`, {
						headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe' },
					});
					const refBody = await refResp.json() as { object?: { sha?: string } };
					latestSha = refBody.object?.sha ?? '';
					if (latestSha) {
						break;
					}
					if (attempt < 4) {
						await new Promise(r => setTimeout(r, 2000));
					}
				}
				if (!latestSha) {
					return errorResult('Could not get latest commit SHA. The repository may not have a main branch. Please ensure the repository is initialized with at least one commit.');
				}

				// 4. Base tree
				const commitResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/commits/${latestSha}`, {
					headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe' },
				});
				const commitBody = await commitResp.json() as { tree?: { sha?: string } };
				const baseTree = commitBody.tree?.sha ?? '';

				// 5. Create tree
				const treeItems = fileContents
					.filter(([, content]) => content.length > 0)
					.map(([name, content]) => ({
						path: `${pathPrefix}${name}`,
						mode: '100644',
						type: 'blob',
						content,
					}));
				const treeResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/trees`, {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${token}`,
						'User-Agent': 'aria-autopipe',
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ base_tree: baseTree, tree: treeItems }),
				});
				const treeBody = await treeResp.json() as { sha?: string };
				const newTreeSha = treeBody.sha ?? '';

				// 6. Create commit
				const commitMsg = args.commit_message ? String(args.commit_message) : `Upload ${pipelineName}`;
				const newCommitResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/commits`, {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${token}`,
						'User-Agent': 'aria-autopipe',
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ message: commitMsg, tree: newTreeSha, parents: [latestSha] }),
				});
				const newCommitBody = await newCommitResp.json() as { sha?: string };
				const newCommitSha = newCommitBody.sha ?? '';

				// 7. Update ref
				const updateRef = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/refs/heads/main`, {
					method: 'PATCH',
					headers: {
						'Authorization': `Bearer ${token}`,
						'User-Agent': 'aria-autopipe',
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ sha: newCommitSha }),
				});
				if (!updateRef.ok) {
					const err = await updateRef.text();
					return errorResult(`Failed to update branch ref: ${err}`);
				}

				const githubUrl = perPipeline
					? `https://github.com/${owner}/${repoName}`
					: `https://github.com/${owner}/${repoName}/tree/main/pipelines/${pipelineName}`;
				const commitUrl = `https://github.com/${owner}/${repoName}/commit/${newCommitSha}`;

				return textResult(
					`Successfully uploaded '${pipelineName}' to GitHub!\n`
					+ `Pipeline URL: ${githubUrl}\n`
					+ `Commit: ${commitUrl}`,
				);
			} catch (err) {
				return errorResult(`upload_pipeline failed: ${(err as Error).message}`);
			}
		},
	},
	{
		name: 'publish_pipeline',
		description: "Publish a pipeline from GitHub to the AutoPipe registry. PREREQUISITE: Call upload_pipeline FIRST. The registry reads the pipeline name from ro-crate-metadata.json on GitHub — NOT from any parameter. So the name in ro-crate-metadata.json (in the directory referenced by github_url) is what gets registered. Duplicate detection is handled automatically by this tool. Same name + same author: returns existing pipeline info — you MUST ask the user 'Would you like to register this as a new version of the existing pipeline?' before proceeding. If user agrees, call this tool again with forked_from set to the existing pipeline_id. Same name + different author: returns info for user to choose — either change the pipeline name or mark as 'Based on' by setting forked_from to the existing pipeline_id. CRITICAL — RENAME GUARD: If the user wanted a NEW name (e.g., 'publish as test' for a pipeline originally named aptaselect), the rename must already be reflected in BOTH (a) the GitHub directory path inside the github_url AND (b) the `name` field of ro-crate-metadata.json at that path. Before calling this tool, fetch the ro-crate at github_url and verify the name field matches what the user asked for. If the name does not match, STOP and re-run upload_pipeline with the corrected ro-crate first. Calling publish_pipeline with a stale ro-crate will register under the WRONG name and create a duplicate version of the original pipeline. MANDATORY — LINEAGE CONFIRMATION: BEFORE calling this tool, you MUST fetch ro-crate-metadata.json at the github_url and check whether the dataset node (@id == './') contains an `isBasedOn` field. If it does AND the URL points to this AutoPipe Hub (matches the configured registry_url + '/pipelines/<id>' pattern), you MUST first ask the user a confirmation question in their language. Example (in English; translate to the user's language at runtime): 'It looks like this pipeline was downloaded from <original name>(#<original id>) and modified. Is that correct? If yes, the source (forked_from) will be recorded automatically. If not, the lineage will be cleared and this will be registered as an independent pipeline.' Look up the original pipeline's name and id from the isBasedOn URL (the trailing /pipelines/<id> part) and the registry's get_pipeline endpoint. If the user confirms it IS a fork: call this tool normally without forked_from — auto-detection will populate it. If the user says it is NOT based on the original (independent pipeline): call this tool with forked_from=null AND instruct the user to remove the isBasedOn field from ro-crate-metadata.json so future publishes are clean. Skip this confirmation only when isBasedOn is absent or points to an external (non-Hub) URL.",
		inputSchema: {
			type: 'object',
			properties: {
				github_url: { type: 'string', description: 'GitHub URL of the uploaded pipeline (from upload_pipeline result)' },
				forked_from: { type: 'integer', description: 'Set to an existing pipeline_id to link this as a related/derived version.' },
			},
			required: ['github_url'],
		},
		handler: async (args) => {
			try {
				const cfg = services().config.get();
				const token = cfg.github?.token;
				if (!token) {
					return errorResult('GitHub login is required. Please open the Autopipe panel, connect GitHub from the GitHub section, and try again.');
				}
				const base = cfg.registry_url.replace(/\/+$/, '');
				const githubUrl = String(args.github_url ?? '');
				if (!githubUrl) {
					return errorResult('publish_pipeline: `github_url` is required');
				}

				const userLogin = await fetchGithubLogin(token);
				const myAuthor = userLogin ?? '';

				const isSingleRepo = githubUrl.includes('/pipelines/');
				const parsed = parseGithubUrl(githubUrl);
				if (!parsed) {
					return errorResult(`Invalid GitHub URL: ${githubUrl}`);
				}
				const { owner: ghOwner, repo: ghRepo, path: subpath } = parsed;

				// 1) Pipeline name discovery — single-repo: parse URL, per-pipeline: read root metadata.
				let pipelineName = '';
				if (isSingleRepo) {
					const parts = githubUrl.replace(/\/+$/, '').split('/');
					for (let i = 0; i < parts.length; i++) {
						if (parts[i] === 'pipelines' && i + 1 < parts.length) {
							pipelineName = parts[i + 1];
							break;
						}
					}
				} else {
					const meta = await fetchGithubFile(ghOwner, ghRepo, 'ro-crate-metadata.json', token);
					if (meta) {
						try {
							const data = JSON.parse(cleanContent(meta));
							const graph = data['@graph'];
							if (Array.isArray(graph)) {
								const ds = graph.find((n: { '@id'?: string }) => n['@id'] === './');
								if (ds && typeof ds.name === 'string') {
									pipelineName = ds.name;
								}
							}
							if (!pipelineName && typeof data.name === 'string') {
								pipelineName = data.name;
							}
						} catch { /* ignore */ }
					}
				}
				if (!pipelineName) {
					// Fallback to metadata file at subpath
					const metaPath = isSingleRepo ? `${subpath}/ro-crate-metadata.json` : 'ro-crate-metadata.json';
					const meta = await fetchGithubFile(ghOwner, ghRepo, metaPath, token);
					if (meta) {
						try {
							const data = JSON.parse(cleanContent(meta));
							const graph = data['@graph'];
							if (Array.isArray(graph)) {
								const ds = graph.find((n: { '@id'?: string }) => n['@id'] === './');
								if (ds && typeof ds.name === 'string') {
									pipelineName = ds.name;
								}
							}
							if (!pipelineName && typeof data.name === 'string') {
								pipelineName = data.name;
							}
						} catch { /* ignore */ }
					}
				}

				// 2) Duplicate detection — search registry for same name.
				let resolvedForkedFrom = args.forked_from === undefined ? null : Number(args.forked_from);
				if ((resolvedForkedFrom === null || !Number.isFinite(resolvedForkedFrom)) && pipelineName) {
					try {
						const searchResp = await fetch(`${base}/api/pipelines?q=${encodeURIComponent(pipelineName)}`);
						if (searchResp.ok) {
							const results = await searchResp.json() as Array<Record<string, unknown>>;
							const exact = results.find(p => p.name === pipelineName);
							if (exact) {
								const existingAuthor = typeof exact.author === 'string' ? exact.author : '';
								const existingId = typeof exact.pipeline_id === 'number' ? exact.pipeline_id : 0;
								const existingVersion = typeof exact.version === 'string' ? exact.version : '?';
								if (existingAuthor === myAuthor) {
									return errorResult(
										`Your pipeline '${pipelineName}' v${existingVersion} already exists in the registry (ID: ${existingId}).\n`
										+ `Ask the user whether to publish as a version upgrade of the existing pipeline.\n`
										+ `If yes: call publish_pipeline again with forked_from=${existingId}.\n`
										+ `If no: the user should change the pipeline name and retry.`,
									);
								}
								return errorResult(
									`A pipeline named '${pipelineName}' already exists by '${existingAuthor}' (v${existingVersion}, ID: ${existingId}).\n`
									+ `Ask the user:\n`
									+ `1. Change the pipeline name to avoid conflict\n`
									+ `2. Mark as 'Based on' this pipeline (call publish_pipeline again with forked_from=${existingId})`,
								);
							}
						}
					} catch { /* search is best-effort */ }
				}

				// 3) Compute next version from GitHub tags + registry fallback.
				const tagPrefix = pipelineName.replace(/ /g, '-');
				let version = '1.0.0';
				let registryVersion: string | null = null;
				try {
					const searchResp = await fetch(`${base}/api/pipelines?q=${encodeURIComponent(pipelineName)}`);
					if (searchResp.ok) {
						const results = await searchResp.json() as Array<Record<string, unknown>>;
						const exact = results.find(p => p.name === pipelineName);
						if (exact && typeof exact.version === 'string') {
							registryVersion = exact.version;
						}
					}
				} catch { /* ignore */ }
				try {
					const tagsResp = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/git/matching-refs/tags/${tagPrefix}/v`, {
						headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe' },
					});
					if (tagsResp.ok) {
						const tags = await tagsResp.json() as Array<{ ref?: string }>;
						if (tags.length === 0) {
							if (registryVersion) {
								const parts = registryVersion.split('.').map(p => parseInt(p, 10) || 0);
								if (parts.length === 3) {
									version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
								}
							}
						} else {
							let latest: [number, number, number] = [1, 0, 0];
							for (const tag of tags) {
								if (!tag.ref) {
									continue;
								}
								const idx = tag.ref.lastIndexOf('/v');
								if (idx < 0) {
									continue;
								}
								const verStr = tag.ref.slice(idx + 2);
								const parts = verStr.split('.').map(p => parseInt(p, 10) || 0);
								if (parts.length === 3) {
									const v: [number, number, number] = [parts[0], parts[1], parts[2]];
									if (v[0] > latest[0] || (v[0] === latest[0] && (v[1] > latest[1] || (v[1] === latest[1] && v[2] > latest[2])))) {
										latest = v;
									}
								}
							}
							version = `${latest[0]}.${latest[1]}.${latest[2] + 1}`;
						}
					}
				} catch { /* default 1.0.0 */ }

				// 4) Update version inside ro-crate-metadata.json + commit to GitHub.
				const metaPath = isSingleRepo ? `pipelines/${pipelineName}/ro-crate-metadata.json` : 'ro-crate-metadata.json';
				try {
					const metaStr = await fetchGithubFile(ghOwner, ghRepo, metaPath, token);
					if (metaStr) {
						const metaJson = JSON.parse(metaStr);
						metaJson.version = version;
						const graph = metaJson['@graph'];
						if (Array.isArray(graph)) {
							const ds = graph.find((n: { '@id'?: string }) => n['@id'] === './');
							if (ds) {
								ds.version = version;
							}
						}
						const updatedMeta = JSON.stringify(metaJson, null, 2);

						const refResp = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/git/ref/heads/main`, {
							headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe' },
						});
						if (refResp.ok) {
							const refBody = await refResp.json() as { object?: { sha?: string } };
							const latestSha = refBody.object?.sha ?? '';
							if (latestSha) {
								const commitResp = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/git/commits/${latestSha}`, {
									headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe' },
								});
								if (commitResp.ok) {
									const commitBody = await commitResp.json() as { tree?: { sha?: string } };
									const baseTree = commitBody.tree?.sha ?? '';
									const treeResp = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/git/trees`, {
										method: 'POST',
										headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe', 'Content-Type': 'application/json' },
										body: JSON.stringify({
											base_tree: baseTree,
											tree: [{ path: metaPath, mode: '100644', type: 'blob', content: updatedMeta }],
										}),
									});
									if (treeResp.ok) {
										const treeBody = await treeResp.json() as { sha?: string };
										const newTree = treeBody.sha ?? '';
										const commitResp2 = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/git/commits`, {
											method: 'POST',
											headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe', 'Content-Type': 'application/json' },
											body: JSON.stringify({
												message: `Publish ${pipelineName} v${version}`,
												tree: newTree,
												parents: [latestSha],
											}),
										});
										if (commitResp2.ok) {
											const cb2 = await commitResp2.json() as { sha?: string };
											const newSha = cb2.sha ?? '';
											if (newSha) {
												await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/git/refs/heads/main`, {
													method: 'PATCH',
													headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe', 'Content-Type': 'application/json' },
													body: JSON.stringify({ sha: newSha }),
												});
											}
										}
									}
								}
							}
						}
					}
				} catch { /* version-bump is best-effort */ }

				// 5) Resolve main HEAD SHA for the publish payload + tag creation.
				const tagName = `${pipelineName.replace(/ /g, '-')}/v${version}`;
				let mainSha: string | null = null;
				try {
					const r = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/git/ref/heads/main`, {
						headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe' },
					});
					if (r.ok) {
						const j = await r.json() as { object?: { sha?: string } };
						if (j.object?.sha) {
							mainSha = j.object.sha;
						}
					}
				} catch { /* ignore */ }

				// 6) Registry publish.
				const publishBody: Record<string, unknown> = {
					github_url: githubUrl,
					github_token: token,
					forked_from: resolvedForkedFrom,
				};
				if (mainSha) {
					publishBody.git_tag = tagName;
					publishBody.commit_sha = mainSha;
				}
				const pubResp = await fetch(`${base}/api/publish`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(publishBody),
				});
				const body = await pubResp.json() as Record<string, unknown>;
				if (!pubResp.ok) {
					return errorResult(`Publish failed: ${typeof body.error === 'string' ? body.error : 'Unknown error'}`);
				}

				// 7) Create the version tag at the same SHA (best-effort).
				if (mainSha) {
					try {
						await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/git/refs`, {
							method: 'POST',
							headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe', 'Content-Type': 'application/json' },
							body: JSON.stringify({ ref: `refs/tags/${tagName}`, sha: mainSha }),
						});
					} catch { /* ignore */ }
				}

				const pipelineId = typeof body.pipeline_id === 'number' ? body.pipeline_id : 0;
				const name = typeof body.name === 'string' ? body.name : 'unknown';
				const webUrl = `${base}/pipelines/${pipelineId}`;
				return textResult([
					`Successfully published '${name}' v${version} to the registry!`,
					`Web page: ${webUrl}`,
					`Pipeline ID: ${pipelineId}`,
				].join('\n'));
			} catch (err) {
				return errorResult(`publish_pipeline failed: ${(err as Error).message}`);
			}
		},
	},
	{
		name: 'unpublish_pipeline',
		description: "Remove a pipeline that you previously published to Autopipe Hub. "
			+ "This deletes (1) the Hub registry record(s), and (2) the corresponding GitHub git tag(s) of the form `refs/tags/<pipeline-name>/v<version>` so the same version can be cleanly republished later. "
			+ "GITHUB SOURCE FILES ARE NOT DELETED BY THIS TOOL. The `pipelines/<name>/` directory and its files remain in your GitHub repository. If the user asks you to also delete the pipeline source code or files from GitHub, you MUST refuse and tell the user: this tool can only remove the pipeline from the Autopipe Hub and clean up the version tag. To delete the actual source files, the user must do it themselves on GitHub — by deleting the `pipelines/<name>/` directory via the GitHub website, or by deleting the entire repository. "
			+ "Only the pipeline's author can unpublish (the Hub verifies this against your GitHub token). GitHub login is required; if no token is configured the tool will tell you to connect GitHub via the AutoPipe app's GitHub panel. "
			+ "TWO-CALL PROTOCOL: "
			+ "First call (without `scope`): the tool fetches the pipeline's version chain — that is, all rows on the Hub with the same name and same author — and returns the list. You MUST present this list to the user IN THEIR LANGUAGE and ask whether to delete only the latest version or every version (example wording in English; translate to the user's language at runtime: 'This pipeline has N version(s) registered. Delete only the latest version, or all versions?'). Wait for an explicit answer. "
			+ "Second call (with `scope='latest'` or `scope='all'`): performs the deletion. Confirm with the user once more in their language before this second call. "
			+ "If other users have forked this pipeline, their forks remain on the Hub but their 'based on' reference becomes a dangling pointer that the Hub UI shows as 'original pipeline has been deleted'.",
		inputSchema: {
			type: 'object',
			properties: {
				pipeline_id: { type: 'integer', description: 'Pipeline ID to unpublish from Autopipe Hub.' },
				scope: { type: 'string', description: '"latest" or "all". Omit on the first call to discover how many versions exist.', enum: ['latest', 'all'] },
			},
			required: ['pipeline_id'],
		},
		handler: async (args) => {
			try {
				const cfg = services().config.get();
				const token = cfg.github?.token;
				if (!token) {
					return errorResult('GitHub login is required to unpublish a pipeline because the Hub verifies ownership via your GitHub token. Please open the Autopipe panel, connect GitHub from the GitHub section, and try again.');
				}
				const base = cfg.registry_url.replace(/\/+$/, '');
				const pipelineId = Number(args.pipeline_id);
				if (!Number.isInteger(pipelineId)) {
					return errorResult('unpublish_pipeline: `pipeline_id` must be an integer');
				}

				// 1. Fetch the version chain.
				const chainResp = await fetch(`${base}/api/pipelines/${pipelineId}/versions`);
				if (!chainResp.ok) {
					return errorResult('Pipeline not found on the Hub.');
				}
				const body = await chainResp.json() as { versions?: Array<Record<string, unknown>> };
				const versions = body.versions ?? [];
				if (versions.length === 0) {
					return errorResult('Pipeline not found on the Hub.');
				}

				// 2. First call (no scope): return the chain.
				const scopeArg = args.scope;
				if (scopeArg !== 'latest' && scopeArg !== 'all') {
					if (scopeArg !== undefined) {
						return errorResult(`Invalid scope '${scopeArg}'. Use 'latest' or 'all'.`);
					}
					const info = versions.map(v =>
						`- pipeline_id=${v.pipeline_id}, version=${typeof v.version === 'string' ? v.version : '?'}`,
					).join('\n');
					const name0 = typeof versions[0].name === 'string' ? versions[0].name : '';
					const auth0 = typeof versions[0].author === 'string' ? versions[0].author : '';
					return textResult(
						`Pipeline '${name0}' (by ${auth0}) has ${versions.length} version(s):\n${info}\n\n`
						+ `Ask the user whether to delete only the latest version or all versions, then call this tool again with scope='latest' or scope='all'.`,
					);
				}

				const targets = scopeArg === 'latest' ? [versions[0]] : versions;
				const githubUrl = typeof versions[0].github_url === 'string' ? versions[0].github_url : '';
				const parsedRepo = githubUrl ? parseGithubUrl(githubUrl) : null;

				const results: string[] = [];
				for (const v of targets) {
					const pid = typeof v.pipeline_id === 'number' ? v.pipeline_id : 0;
					const pname = typeof v.name === 'string' ? v.name : '';
					const pver = typeof v.version === 'string' ? v.version : '';

					// 3a. Delete the Hub row.
					const delResp = await fetch(`${base}/api/pipelines/${pid}`, {
						method: 'DELETE',
						headers: { 'Authorization': `Bearer ${token}` },
					});
					if (delResp.status !== 200) {
						let reason: string;
						switch (delResp.status) {
							case 401: reason = 'authentication failed'; break;
							case 403: reason = 'forbidden (not your pipeline)'; break;
							case 404: reason = 'not found (already deleted?)'; break;
							default: reason = 'HTTP error';
						}
						results.push(`x pipeline_id=${pid} Hub delete failed: ${reason} (HTTP ${delResp.status})`);
						continue;
					}

					// 3b. Delete the GitHub tag.
					if (parsedRepo) {
						const tag = `${pname.replace(/ /g, '-')}/v${pver}`;
						try {
							const tagResp = await fetch(`https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.repo}/git/refs/tags/${tag}`, {
								method: 'DELETE',
								headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'aria-autopipe' },
							});
							if (tagResp.ok || tagResp.status === 422 || tagResp.status === 404) {
								results.push(`OK pipeline_id=${pid} deleted (Hub row + tag ${tag})`);
							} else {
								results.push(`OK pipeline_id=${pid} Hub deleted, but tag ${tag} cleanup returned HTTP ${tagResp.status}`);
							}
						} catch {
							results.push(`OK pipeline_id=${pid} Hub deleted, but tag ${tag} cleanup failed (network)`);
						}
					} else {
						results.push(`OK pipeline_id=${pid} Hub deleted (could not parse github_url for tag cleanup)`);
					}
				}

				const pname0 = typeof versions[0].name === 'string' ? versions[0].name : '';
				return textResult(
					`Unpublish complete (scope=${scopeArg}, ${targets.length} version(s) processed):\n`
					+ results.join('\n')
					+ '\n\n'
					+ `Note: GitHub source files in \`pipelines/${pname0}/\` remain in your repository. `
					+ 'This tool does not delete those files — if the user wants to remove them, they must do so directly from GitHub '
					+ `(delete the \`pipelines/${pname0}/\` directory via the GitHub website, or delete the entire repository). `
					+ 'Future uploads of the same pipeline name will overwrite these files; if the user plans to publish a different pipeline under the same name, '
					+ 'advise them to change the pipeline name in `ro-crate-metadata.json` to avoid mixing files from this version with the new one.',
				);
			} catch (err) {
				return errorResult(`unpublish_pipeline failed: ${(err as Error).message}`);
			}
		},
	},
	{
		name: 'delete_pipeline',
		description: "Delete a pipeline's source code directory and its Docker image/containers from the remote server. "
			+ "ONLY call this when the user has explicitly said they want to delete the local pipeline code (e.g. 'delete the pipeline', 'remove the pipeline'). "
			+ "Do NOT call this during build errors, execution failures, code generation, or any troubleshooting — use cleanup_failed for those cases. "
			+ "Before calling this tool, ask the user once to confirm (e.g. 'Are you sure you want to delete the pipeline source code?'), then call this tool immediately after confirmation. Do NOT ask the user to run commands manually. "
			+ "Uses Docker to handle root-owned files so permissions are never an issue.",
		inputSchema: {
			type: 'object',
			properties: {
				pipeline_dir: { type: 'string', description: 'Full path to the pipeline source directory on the remote server' },
				image_name: { type: 'string', description: 'Docker image name to remove along with the pipeline. Optional — omit if no image was built.' },
			},
			required: ['pipeline_dir'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const dir = String(args.pipeline_dir ?? '');
				const image = args.image_name ? String(args.image_name) : '';
				if (!dir) {
					return errorResult('delete_pipeline: `pipeline_dir` is required');
				}
				const steps: string[] = [`rm -rf -- ${q(dir)}`];
				if (image) {
					steps.push(`docker rmi -f ${q(image)} 2>/dev/null || true`);
				}
				const { ssh } = services();
				const { stderr, exitCode } = await ssh.run(profile, steps.join(' && '));
				if (exitCode !== 0) {
					return errorResult(`delete_pipeline failed (exit ${exitCode}): ${stderr.trim()}`);
				}
				return textResult(`Deleted ${dir}${image ? ` and image ${image}` : ''}.`);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'validate_pipeline',
		description: 'Validate a pipeline directory structure on the remote SSH server',
		inputSchema: {
			type: 'object',
			properties: {
				pipeline_dir: { type: 'string', description: 'Remote path to the pipeline directory on the SSH server' },
			},
			required: ['pipeline_dir'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const cfg = services().config.get();
				const dir = windowsToWsl(String(args.pipeline_dir ?? ''));
				if (!dir) {
					return errorResult('validate_pipeline: `pipeline_dir` is required');
				}
				const errors: string[] = [];
				const notices: string[] = [];
				const required = ['Snakefile', 'Dockerfile', 'config.yaml', 'ro-crate-metadata.json', 'README.md'];

				for (const f of required) {
					const fullPath = `${dir}/${f}`;
					let buf: Buffer;
					try {
						buf = await ssh.readFile(profile, fullPath);
					} catch {
						errors.push(`Missing: ${f}`);
						continue;
					}
					const raw = buf.toString('utf8');
					if (!raw) {
						errors.push(`Empty: ${f}`);
						continue;
					}
					const content = cleanContent(raw);
					if (f === 'Snakefile' && !content.includes('rule all')) {
						errors.push("Snakefile: missing 'rule all'");
					}
					if (f === 'ro-crate-metadata.json') {
						let meta;
						try {
							meta = parseRoCrateMetadata(content);
						} catch (e) {
							errors.push(`ro-crate-metadata.json: invalid - ${(e as Error).message}`);
							continue;
						}
						if (!meta.name) {
							errors.push("ro-crate-metadata.json: 'name' is empty");
						}
						if (!meta.author) {
							const token = cfg.github?.token;
							const login = await fetchGithubLogin(token);
							if (login) {
								try {
									const updated = fillRoCrateAuthor(content, login);
									try {
										await ssh.writeFile(profile, fullPath, updated);
										notices.push(`Auto-filled '#author.name' in ro-crate-metadata.json with '${login}' from your GitHub login.`);
									} catch (e) {
										errors.push(`ro-crate-metadata.json: '#author.name' was empty and auto-fill via SSH failed (${(e as Error).message}). Check your SSH connection and re-run validate_pipeline; it will retry the fix automatically.`);
									}
								} catch (e) {
									errors.push(`ro-crate-metadata.json: '#author.name' is empty and auto-fill failed to rewrite the file (${(e as Error).message}).`);
								}
							} else {
								errors.push("ro-crate-metadata.json: '#author.name' is empty and GitHub is not connected. Open the Autopipe panel, complete the GitHub connection step, then re-run validate_pipeline (it will auto-fill the author from your GitHub login).");
							}
						}
					}
				}

				if (errors.length === 0) {
					let msg = 'Validation passed. All files present and valid.';
					if (notices.length > 0) {
						msg += '\n\nNotes:\n' + notices.map(n => `- ${n}`).join('\n');
					}
					return textResult(msg);
				}
				return errorResult(`Validation errors:\n${errors.join('\n')}`);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
];
