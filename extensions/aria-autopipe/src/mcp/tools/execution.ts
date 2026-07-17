/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDefinition, textResult, errorResult } from './types';
import { services } from '../../common/services';
import { workspacePathsFor } from '../../common/types';
import { shellEscape } from '../../common/roCrate';
import {
	windowsToWsl,
	resolveOutputDir,
	resolveDockerSocketMount,
	resolveSymlinkTargets,
	findPipelineDir,
} from '../../common/dockerEnv';
import { autoSavePipelineCodeOnCompletion } from '../../common/workspaceSync';

/**
 * Docker / Snakemake execution tools - faithful ports of build_image,
 * check_build_status, dry_run, execute_pipeline, list_running_pipelines,
 * check_status, and cleanup_failed from autopipe-app's `mcp/server.rs`.
 */

function requireProfile() {
	const { config } = services();
	const profile = config.activeProfile();
	if (!profile) {
		throw new Error('No active SSH profile. Configure one via Aria > Autopipe > SSH.');
	}
	return profile;
}

export const EXECUTION_TOOLS: ToolDefinition[] = [
	{
		name: 'build_image',
		description: 'Build a Docker image for a pipeline on the remote server via SSH. The build runs in the background and returns immediately. After calling this, automatically call check_build_status every 10 seconds until the build completes. Do NOT ask the user to check - poll automatically. If the build fails, analyze the log, call cleanup_failed, fix the pipeline, and retry. Multi-client note: do not start two builds for the same image_name from different AI clients at once.',
		inputSchema: {
			type: 'object',
			properties: {
				pipeline_dir: { type: 'string', description: 'Remote path to the pipeline directory (on the SSH server)' },
				image_name: { type: 'string', description: 'Docker image name/tag' },
			},
			required: ['pipeline_dir', 'image_name'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const paths = workspacePathsFor(profile);
				const logDir = paths.output_dir;
				const imageName = String(args.image_name ?? '');
				const pipelineDir = windowsToWsl(String(args.pipeline_dir ?? ''));
				if (!imageName || !pipelineDir) {
					return errorResult('build_image: `pipeline_dir` and `image_name` are required');
				}
				const logPath = `${logDir.replace(/\/+$/, '')}/build_${imageName}.log`;

				await ssh.run(profile, `mkdir -p '${shellEscape(logDir)}'`);

				const cmd =
					`cd '${shellEscape(pipelineDir)}' && nohup docker build -t '${shellEscape(imageName)}' . `
					+ `> '${shellEscape(logPath)}' 2>&1 &\necho $!`;
				const r = await ssh.run(profile, cmd);
				if (r.exitCode !== 0) {
					return errorResult(r.stderr.trim() || 'Failed to start build');
				}
				const pid = r.stdout.trim();
				return textResult(
					`Docker build started in background (PID: ${pid}).\n`
					+ `Log: ${logPath}\n`
					+ `Now call check_build_status with image_name='${imageName}' every 10 seconds to monitor progress.`,
				);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'check_build_status',
		description: 'Check the status of a background Docker build started by build_image. Returns building/success/failed status with recent log output. Call this automatically every 10 seconds after build_image - do NOT wait for the user to ask.',
		inputSchema: {
			type: 'object',
			properties: {
				image_name: { type: 'string', description: 'Docker image name (same as used in build_image)' },
			},
			required: ['image_name'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const paths = workspacePathsFor(profile);
				const imageName = String(args.image_name ?? '');
				if (!imageName) {
					return errorResult('check_build_status: `image_name` is required');
				}

				const checkCmd = `ps aux | grep 'docker build.*${shellEscape(imageName)}' | grep -v grep | head -1`;
				const isRunningRes = await ssh.run(profile, checkCmd);
				const isRunning = isRunningRes.stdout.trim().length > 0;

				const imageCheck = `docker images -q '${shellEscape(imageName)}' 2>/dev/null`;
				const imgRes = await ssh.run(profile, imageCheck);
				const imageExists = imgRes.exitCode === 0 && imgRes.stdout.trim().length > 0;

				const logDir = paths.output_dir;
				let actualLogPath = `${logDir.replace(/\/+$/, '')}/build_${imageName}.log`;
				const probe = await ssh.run(profile, `test -f '${shellEscape(actualLogPath)}' && echo exists`);
				if (!(probe.exitCode === 0 && probe.stdout.includes('exists'))) {
					const findLog = `find '${shellEscape(paths.pipelines_dir)}' -name 'build_${shellEscape(imageName)}.log' 2>/dev/null | head -1`;
					const findRes = await ssh.run(profile, findLog);
					if (findRes.exitCode === 0 && findRes.stdout.trim()) {
						actualLogPath = findRes.stdout.trim();
					}
				}

				let recentLog = 'Log not found';
				try {
					const tailRes = await ssh.run(profile, `tail -30 '${shellEscape(actualLogPath)}' 2>/dev/null`);
					recentLog = tailRes.stdout;
				} catch { /* keep default */ }

				if (isRunning) {
					return textResult(`Build in progress...\n\nRecent log:\n${recentLog}`);
				}
				if (imageExists) {
					await ssh.run(profile, `rm -f '${shellEscape(actualLogPath)}'`);
					return textResult(`Build completed successfully! Image '${imageName}' is ready.\n\nFinal log:\n${recentLog}`);
				}
				return errorResult(
					`Build failed.\n\nBuild log:\n${recentLog}\n\n`
					+ 'Next steps: Analyze the error above, fix the pipeline code (Dockerfile or Snakefile), then retry build_image. Only call cleanup_failed if you need to remove the Docker image before rebuilding.',
				);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'dry_run',
		description: 'Dry-run a pipeline (snakemake -n -p) on the remote server via SSH. If output_dir is omitted, uses the configured output directory.',
		inputSchema: {
			type: 'object',
			properties: {
				image_name: { type: 'string' },
				input_dir: { type: 'string' },
				output_dir: { type: 'string' },
				cores: { type: 'integer' },
				needs_docker_socket: { type: 'boolean' },
			},
			required: ['image_name', 'input_dir'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const paths = workspacePathsFor(profile);
				const cores = Number.isInteger(args.cores) ? Number(args.cores) : 8;
				const dryRunDir = `${paths.output_dir.replace(/\/+$/, '')}/.dry_run_tmp`;
				const imageName = String(args.image_name ?? '');
				const inputDir = windowsToWsl(String(args.input_dir ?? ''));
				const outputDirRaw = args.output_dir && String(args.output_dir).length > 0
					? windowsToWsl(String(args.output_dir))
					: dryRunDir;
				const outputDir = outputDirRaw;

				if (!imageName || !inputDir) {
					return errorResult('dry_run: `image_name` and `input_dir` are required');
				}

				// Create both mount dirs as the SSH user before docker touches them, so
				// docker never auto-creates the input dir as root (see execute_pipeline).
				await ssh.run(profile, `mkdir -p '${shellEscape(inputDir)}' '${shellEscape(outputDir)}'`);

				const pipelineDir = await findPipelineDir(profile, imageName);
				const pipelineMount = pipelineDir ? `-v '${shellEscape(pipelineDir)}:/pipeline'` : '';

				const symlinkTargets = await resolveSymlinkTargets(profile, inputDir);
				const symlinkMounts = symlinkTargets.map(t => ` -v '${shellEscape(t)}:${shellEscape(t)}:ro'`).join('');

				let dockerSocketMount = '';
				let hostPathMounts = '';
				let hostEnvVars = '';
				if (args.needs_docker_socket === true) {
					dockerSocketMount = await resolveDockerSocketMount(profile);
					hostPathMounts = ` -v '${shellEscape(inputDir)}:${shellEscape(inputDir)}:ro' -v '${shellEscape(outputDir)}:${shellEscape(outputDir)}'`;
					if (pipelineDir) {
						hostPathMounts += ` -v '${shellEscape(pipelineDir)}:${shellEscape(pipelineDir)}'`;
					}
					for (const t of symlinkTargets) {
						hostPathMounts += ` -v '${shellEscape(t)}:${shellEscape(t)}:ro'`;
					}
					hostEnvVars = ` -e HOST_INPUT_DIR='${shellEscape(inputDir)}' -e HOST_OUTPUT_DIR='${shellEscape(outputDir)}'`;
					if (pipelineDir) {
						hostEnvVars += ` -e HOST_PIPELINE_DIR='${shellEscape(pipelineDir)}'`;
					}
				}

				const cmd =
					`docker run --rm --entrypoint snakemake ${pipelineMount}${dockerSocketMount}${hostPathMounts}${hostEnvVars} `
					+ `-v '${shellEscape(inputDir)}:/input:ro'${symlinkMounts} `
					+ `-v '${shellEscape(outputDir)}:/output' -w /output `
					+ `'${shellEscape(imageName)}' --cores ${cores} --rerun-incomplete `
					+ `--snakefile /pipeline/Snakefile --configfile /pipeline/config.yaml -n -p`;

				const r = await ssh.run(profile, cmd, { timeoutMs: 600000 });
				const result = r.exitCode === 0 ? textResult(r.stdout) : errorResult(r.stdout || r.stderr);

				if (outputDir === dryRunDir) {
					await ssh.run(
						profile,
						`docker run --rm -v '${shellEscape(dryRunDir)}:/target' alpine rm -rf /target`,
					);
				}
				return result;
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'execute_pipeline',
		description: 'Execute a pipeline in the background on the remote server via SSH. Outputs are stored at {configured_output_dir}/{run_name}/. Logs are written to {output_dir}/{run_name}/pipeline.log. This tool monitors the first ~90 seconds for early failures before returning. Snakemake automatically skips completed steps, so if a pipeline fails you can fix the code and re-run with the SAME run_name - only the failed and downstream steps will re-execute. Do NOT call cleanup_failed after execution failures; instead fix the Snakefile and re-run. Tell the user they can check progress later with list_running_pipelines, even from a new conversation session. When a run COMPLETES, the pipeline code is auto-saved into the open project folder (autopipe/pipelines/); then OFFER to save results durably: call list_run_outputs to show output files with sizes, ASK the user which to save (warn before copying large files), and call save_results_to_project. The run target (built-in VM) is a scratch disk, so results only persist once saved to the project. Multi-client note: this AutoPipe instance may be shared by multiple AI clients (Claude Desktop, Cursor, Codex, etc.); avoid running pipelines with the same run_name simultaneously from different clients - only one execution per run_name at a time.',
		inputSchema: {
			type: 'object',
			properties: {
				image_name: { type: 'string' },
				run_name: { type: 'string' },
				input_dir: { type: 'string' },
				cores: { type: 'integer' },
				needs_docker_socket: { type: 'boolean' },
			},
			required: ['image_name', 'run_name', 'input_dir'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const cores = Number.isInteger(args.cores) ? Number(args.cores) : 8;
				const runName = String(args.run_name ?? '');
				const imageName = String(args.image_name ?? '');
				const inputDir = windowsToWsl(String(args.input_dir ?? ''));
				if (!runName || !imageName || !inputDir) {
					return errorResult('execute_pipeline: `image_name`, `run_name`, `input_dir` are required');
				}
				const outputDir = resolveOutputDir(profile, runName);
				const containerName = `${runName}-run`;
				const logPath = `${outputDir.replace(/\/+$/, '')}/pipeline.log`;

				const pipelineDir = await findPipelineDir(profile, imageName);
				const pipelineMount = pipelineDir ? `-v '${shellEscape(pipelineDir)}:/pipeline'` : '';

				const symlinkTargets = await resolveSymlinkTargets(profile, inputDir);
				const symlinkMounts = symlinkTargets.map(t => ` -v '${shellEscape(t)}:${shellEscape(t)}:ro'`).join('');

				let dockerSocketMount = '';
				let hostPathMounts = '';
				let hostEnvVars = '';
				if (args.needs_docker_socket === true) {
					dockerSocketMount = await resolveDockerSocketMount(profile);
					hostPathMounts = ` -v '${shellEscape(inputDir)}:${shellEscape(inputDir)}:ro' -v '${shellEscape(outputDir)}:${shellEscape(outputDir)}'`;
					if (pipelineDir) {
						hostPathMounts += ` -v '${shellEscape(pipelineDir)}:${shellEscape(pipelineDir)}'`;
					}
					for (const t of symlinkTargets) {
						hostPathMounts += ` -v '${shellEscape(t)}:${shellEscape(t)}:ro'`;
					}
					hostEnvVars = ` -e HOST_INPUT_DIR='${shellEscape(inputDir)}' -e HOST_OUTPUT_DIR='${shellEscape(outputDir)}'`;
					if (pipelineDir) {
						hostEnvVars += ` -e HOST_PIPELINE_DIR='${shellEscape(pipelineDir)}'`;
					}
				}

				await ssh.run(profile, `docker rm -f '${shellEscape(containerName)}' 2>/dev/null`);
				// Create BOTH mount dirs as the (aria) SSH user BEFORE docker runs.
				// Docker auto-creates a missing bind-mount source dir as ROOT, which then
				// blocks prepare_input / symlinks / uploads with "Permission denied". So
				// ensure the input dir exists user-owned here too, not just the output dir.
				await ssh.run(profile, `mkdir -p '${shellEscape(inputDir)}' '${shellEscape(outputDir)}'`);

				const runMeta = JSON.stringify({
					run_name: runName,
					image_name: imageName,
					container_name: containerName,
					input_dir: inputDir,
					started_at: new Date().toISOString(),
				});
				const metaPath = `${outputDir.replace(/\/+$/, '')}/.autopipe-run.json`;
				try { await ssh.writeFile(profile, metaPath, runMeta); } catch { /* best-effort */ }

				// Run the container as the server-side user (computed on the server)
				// so result files land user-owned - important for the built-in VM,
				// whose workspace is a 9p share back to the host: otherwise root-owned
				// outputs would be awkward for the user to open/delete. Skipped for the
				// docker-socket (nextflow) path, which needs root to drive the socket.
				const userFlag = dockerSocketMount ? '' : `--user "$(id -u):$(id -g)" `;
				const cmd =
					`nohup docker run --entrypoint snakemake --name '${shellEscape(containerName)}' `
					+ `${userFlag}${pipelineMount}${dockerSocketMount}${hostPathMounts}${hostEnvVars} `
					+ `-v '${shellEscape(inputDir)}:/input:ro'${symlinkMounts} `
					+ `-v '${shellEscape(outputDir)}:/output' -w /output `
					+ `'${shellEscape(imageName)}' --cores ${cores} --rerun-incomplete `
					+ `--snakefile /pipeline/Snakefile --configfile /pipeline/config.yaml `
					+ `> '${shellEscape(logPath)}' 2>&1 &\necho $!`;

				const startRes = await ssh.run(profile, cmd);
				if (startRes.exitCode !== 0) {
					return errorResult(`Failed to start pipeline:\n${startRes.stdout || startRes.stderr}`);
				}
				const startLines = startRes.stdout.trim().split('\n');
				const pid = startLines[startLines.length - 1] || 'unknown';

				const checkIntervals = [10000, 20000, 30000, 30000];
				for (const waitMs of checkIntervals) {
					await new Promise(r => setTimeout(r, waitMs));
					const inspect = await ssh.run(profile, `docker inspect -f '{{.State.Running}}' '${shellEscape(containerName)}' 2>/dev/null`);
					const stillRunning = inspect.exitCode === 0 && inspect.stdout.trim() === 'true';
					if (!stillRunning) {
						const tail = await ssh.run(profile, `tail -30 '${shellEscape(logPath)}' 2>/dev/null`);
						const logTail = tail.exitCode === 0 ? tail.stdout : '(no log available)';
						const hasError = /Error|error|FAILED|failed|Exiting because a job execution failed/.test(logTail);
						const completedOk = logTail.includes('steps (100%) done') || logTail.includes('Nothing to be done');
						if (completedOk) {
							// Best-effort: durably copy the (small) pipeline code into the
							// open project folder. The built-in VM's disk is scratch, so
							// this is the code's only durable home. Never fails the run.
							try {
								await autoSavePipelineCodeOnCompletion(profile, imageName);
							} catch { /* never fail the run over a save */ }
							return textResult(
								`Pipeline completed successfully!\n`
								+ `Output directory: ${outputDir}\n`
								+ `Log: ${logPath}\n\n${logTail}\n\n`
								+ `Pipeline code was auto-saved to the project folder (autopipe/pipelines/). `
								+ `To keep results, call list_run_outputs for run '${runName}', ask the user which files to save (warn about large ones), then save_results_to_project.`,
							);
						}
						if (hasError) {
							return errorResult(
								`Pipeline FAILED early (within 90s). Do NOT call cleanup_failed - intermediate results are preserved.\n`
								+ `Fix the Snakefile and re-run execute_pipeline with the SAME run_name. Snakemake will skip completed steps automatically.\n`
								+ `Container: ${containerName}\n`
								+ `Output directory: ${outputDir}\n`
								+ `Log: ${logPath}\n\n${logTail}`,
							);
						}
					}
				}

				return textResult(
					`Pipeline is running (no errors in first 90s). PID: ${pid}, container: '${containerName}'.\n`
					+ `Output directory: ${outputDir}\n`
					+ `Log file: ${logPath}\n`
					+ `The user can check progress anytime (even in a new session) with list_running_pipelines.`,
				);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'list_running_pipelines',
		description: 'List all pipeline runs (running, completed, or failed). Scans the output directory for .autopipe-run.json metadata files and checks container status. No parameters needed - call this when the user asks about pipeline status, progress, or running jobs.',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const paths = workspacePathsFor(profile);
				const outputBase = paths.output_dir;

				const findCmd = `for f in '${shellEscape(outputBase)}'/*/.autopipe-run.json; do [ -f "$f" ] && cat "$f"; done 2>/dev/null`;
				const metaRes = await ssh.run(profile, findCmd);
				if (metaRes.exitCode !== 0 && metaRes.stderr.trim()) {
					return errorResult(`Cannot scan output directory: ${metaRes.stderr.trim()}`);
				}
				if (!metaRes.stdout.trim()) {
					return textResult('No pipeline runs found in the output directory.');
				}

				const docker = await ssh.run(profile, "docker ps --filter 'name=-run' --format '{{.Names}} {{.Status}}' 2>/dev/null");
				const runningContainers = docker.stdout || '';

				const results: string[] = [];
				for (const rawLine of metaRes.stdout.split('\n')) {
					const line = rawLine.trim();
					if (!line.startsWith('{')) {
						continue;
					}
					let meta: Record<string, unknown>;
					try {
						meta = JSON.parse(line);
					} catch {
						continue;
					}
					const runName = typeof meta.run_name === 'string' ? meta.run_name : 'unknown';
					const image = typeof meta.image_name === 'string' ? meta.image_name : 'unknown';
					const container = typeof meta.container_name === 'string' ? meta.container_name : 'unknown';
					const started = typeof meta.started_at === 'string' ? meta.started_at : 'unknown';

					const isRunning = runningContainers.split('\n').some(l => l.startsWith(container));
					const dockerStatus = runningContainers.split('\n').find(l => l.startsWith(container)) ?? '';

					const logPath = `${outputBase.replace(/\/+$/, '')}/${runName}/pipeline.log`;
					let lastLine = '(no log)';
					const tail = await ssh.run(profile, `tail -3 '${shellEscape(logPath)}' 2>/dev/null`);
					if (tail.exitCode === 0) {
						const trimmed = tail.stdout.trim();
						lastLine = trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed || lastLine;
					}

					let status: string;
					if (isRunning) {
						const dsParts = dockerStatus.split(/\s+/).slice(1).join(' ');
						status = `RUNNING (${dsParts})`;
					} else if (lastLine.includes('100%) done') || lastLine.includes('Nothing to be done')) {
						status = 'COMPLETED';
					} else if (/Error|failed|FAILED/.test(lastLine)) {
						status = 'FAILED';
					} else {
						status = 'STOPPED';
					}

					results.push(`- ${runName} [${status}]\n  Image: ${image}\n  Started: ${started}\n  Log: ${lastLine}`);
				}

				return textResult(`Pipeline runs (${results.length}):\n\n${results.join('\n\n')}`);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'check_status',
		description: 'Check pipeline execution status. Inspects the Docker container for exit code, OOM kill, and other abnormal terminations. If the container has stopped, saves termination info to .autopipe-run.json and removes the container. Falls back to saved JSON when the container is already gone.',
		inputSchema: {
			type: 'object',
			properties: {
				run_name: { type: 'string' },
			},
			required: ['run_name'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const runName = String(args.run_name ?? '');
				if (!runName) {
					return errorResult('check_status: `run_name` is required');
				}
				const outputDir = resolveOutputDir(profile, runName);
				const containerName = `${runName}-run`;
				const logPath = `${outputDir.replace(/\/+$/, '')}/pipeline.log`;
				const metaPath = `${outputDir.replace(/\/+$/, '')}/.autopipe-run.json`;

				const inspectFmt = '{{.State.Running}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.FinishedAt}}';
				const inspect = await ssh.run(profile, `docker inspect -f '${inspectFmt}' '${shellEscape(containerName)}' 2>/dev/null`);

				const tail = await ssh.run(profile, `tail -50 '${shellEscape(logPath)}' 2>/dev/null`);
				let logOutput: string;
				if (tail.exitCode === 0) {
					logOutput = tail.stdout;
				} else if (tail.stdout) {
					logOutput = `(log not available: ${tail.stdout.trim()})`;
				} else {
					logOutput = '(cannot read log)';
				}

				if (inspect.exitCode === 0) {
					const parts = inspect.stdout.trim().split('|');
					if (parts.length === 4) {
						const isRunning = parts[0] === 'true';
						const exitCode = parts[1];
						const oomKilled = parts[2] === 'true';
						const finishedAt = parts[3];

						if (isRunning) {
							return textResult(
								`Status: RUNNING\nContainer: ${containerName}\nOutput: ${outputDir}\nLog (${logPath}):\n${logOutput}`,
							);
						}

						let terminationReason: string;
						if (oomKilled) {
							terminationReason = `OOM_KILLED (Out of Memory) - exit code: ${exitCode}`;
						} else if (exitCode === '137') {
							terminationReason = `KILLED (signal 9, likely OOM or manual kill) - exit code: ${exitCode}`;
						} else if (exitCode === '139') {
							terminationReason = `SEGFAULT (signal 11) - exit code: ${exitCode}`;
						} else if (exitCode === '143') {
							terminationReason = `TERMINATED (signal 15) - exit code: ${exitCode}`;
						} else if (exitCode === '0') {
							terminationReason = 'COMPLETED (exit code: 0)';
						} else {
							terminationReason = `FAILED - exit code: ${exitCode}`;
						}

						let meta: Record<string, unknown> = {};
						const metaRead = await ssh.run(profile, `cat '${shellEscape(metaPath)}' 2>/dev/null`);
						if (metaRead.exitCode === 0) {
							try { meta = JSON.parse(metaRead.stdout.trim()); } catch { /* ignore */ }
						}
						meta.exit_code = exitCode;
						meta.oom_killed = oomKilled;
						meta.finished_at = finishedAt;
						meta.termination_reason = terminationReason;
						try { await ssh.writeFile(profile, metaPath, JSON.stringify(meta)); } catch { /* best-effort */ }

						// On a clean finish, best-effort durable-save the pipeline code
						// into the open project folder (the VM disk is scratch). Uses the
						// image name recorded in the run metadata. Never fails the check.
						if (exitCode === '0' && typeof meta.image_name === 'string') {
							try {
								await autoSavePipelineCodeOnCompletion(profile, meta.image_name);
							} catch { /* never fail check_status over a save */ }
						}

						await ssh.run(profile, `docker rm '${shellEscape(containerName)}' 2>/dev/null`);

						const saveHint = exitCode === '0'
							? `\n\nPipeline code was auto-saved to the project (autopipe/pipelines/). To keep results, call list_run_outputs for '${runName}', ask the user which files to save (warn about large ones), then save_results_to_project.`
							: '';
						return textResult(
							`Status: ${terminationReason}\nContainer: ${containerName} (removed after inspection)\nOutput: ${outputDir}\nFinished at: ${finishedAt}\nLog (${logPath}):\n${logOutput}${saveHint}`,
						);
					}
				}

				let metaInfo = 'Status: UNKNOWN (no container, no metadata found)';
				const metaRead = await ssh.run(profile, `cat '${shellEscape(metaPath)}' 2>/dev/null`);
				if (metaRead.exitCode === 0) {
					try {
						const meta = JSON.parse(metaRead.stdout.trim()) as Record<string, unknown>;
						const reason = typeof meta.termination_reason === 'string' ? meta.termination_reason : 'UNKNOWN';
						const finished = typeof meta.finished_at === 'string' ? meta.finished_at : 'unknown';
						const exitCode = typeof meta.exit_code === 'string' ? meta.exit_code : 'unknown';
						const oom = meta.oom_killed === true;
						if (meta.termination_reason !== undefined) {
							metaInfo = `Status: ${reason} (from saved metadata)\nExit code: ${exitCode}\nOOM killed: ${oom}\nFinished at: ${finished}`;
						} else {
							metaInfo = 'Status: UNKNOWN (container gone, no termination info saved)';
						}
					} catch {
						metaInfo = 'Status: UNKNOWN (container gone, metadata unreadable)';
					}
				}

				return textResult(`${metaInfo}\nContainer: ${containerName}\nOutput: ${outputDir}\nLog (${logPath}):\n${logOutput}`);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'cleanup_failed',
		description: "Clean up artifacts from a failed pipeline. By default, preserves the output directory (so Snakemake can resume from completed steps) and only removes the Docker image. Set remove_output=true ONLY when you want a completely fresh start. Uses Docker to handle root-owned files when normal rm fails due to permissions. For execution failures, prefer fixing the Snakefile and re-running execute_pipeline with the same run_name instead of calling this tool. Multi-client note: do NOT call this on a run_name that another AI client may currently be executing - coordinate with the user first.",
		inputSchema: {
			type: 'object',
			properties: {
				image_name: { type: 'string' },
				run_name: { type: 'string' },
				remove_output: { type: 'boolean' },
			},
			required: ['image_name', 'run_name'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const imageName = String(args.image_name ?? '');
				const runName = String(args.run_name ?? '');
				if (!imageName || !runName) {
					return errorResult('cleanup_failed: `image_name` and `run_name` are required');
				}
				const outputDir = resolveOutputDir(profile, runName);
				const results: string[] = [];

				const runningCheck = await ssh.run(profile, `docker ps -q --filter ancestor='${shellEscape(imageName)}' 2>/dev/null`);
				if (runningCheck.exitCode === 0 && runningCheck.stdout.trim()) {
					return errorResult(`Cannot clean up: image '${imageName}' has running containers. Stop them first.`);
				}

				const containerName = `${runName}-run`;
				const rmCt = await ssh.run(profile, `docker rm '${shellEscape(containerName)}' 2>/dev/null`);
				if (rmCt.exitCode === 0) {
					results.push(`Removed stopped container: ${containerName}`);
				}

				if (args.remove_output === true) {
					const dirExists = await ssh.run(profile, `test -d '${shellEscape(outputDir)}'`);
					if (dirExists.exitCode === 0) {
						const rm = await ssh.run(profile, `rm -rf '${shellEscape(outputDir)}'`);
						if (rm.exitCode === 0) {
							results.push(`Removed output directory: ${outputDir}`);
						} else {
							const dockerRm = await ssh.run(profile, `docker run --rm -v '${shellEscape(outputDir)}:/target' alpine rm -rf /target`);
							if (dockerRm.exitCode === 0) {
								await ssh.run(profile, `mkdir -p '${shellEscape(outputDir)}'`);
								results.push(`Removed output directory via Docker (root-owned files): ${outputDir}`);
							} else {
								results.push(`Failed to remove output directory (permission denied): ${rm.stdout.trim()}`);
							}
						}
					} else {
						results.push(`Output directory not found (already clean): ${outputDir}`);
					}
				} else {
					results.push(`Output directory preserved (Snakemake will resume from completed steps): ${outputDir}`);
				}

				const imgExists = await ssh.run(profile, `docker images -q '${shellEscape(imageName)}' 2>/dev/null`);
				if (imgExists.exitCode === 0) {
					if (imgExists.stdout.trim()) {
						const rmi = await ssh.run(profile, `docker rmi '${shellEscape(imageName)}' 2>/dev/null`);
						if (rmi.exitCode === 0) {
							results.push(`Removed Docker image: ${imageName}`);
						} else {
							results.push(`Failed to remove image: ${rmi.stdout.trim()}`);
						}
					} else {
						results.push(`Docker image not found (already clean): ${imageName}`);
					}
				}

				await ssh.run(profile, 'docker image prune -f --filter dangling=true 2>/dev/null');
				results.push('Pruned dangling images from incomplete builds.');

				return textResult(results.join('\n'));
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
];
