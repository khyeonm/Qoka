/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bundled pipeline templates and the AutoPipe pipeline-generation guide.
 * Ported verbatim from autopipe-app's `crates/common/src/templates.rs`
 * so Claude/Codex see the exact same starter files regardless of whether
 * they're driving the Tauri app or Aria.
 */

export const SNAKEFILE_TEMPLATE = `configfile: "config.yaml"

SAMPLES = config["samples"]

rule all:
    input:
        expand("output/{sample}.final_output", sample=SAMPLES)

rule step_1:
    """First analysis step."""
    input:
        "input/{sample}.fastq.gz"
    output:
        "output/{sample}.step1_output"
    threads: config.get("threads", 4)
    log:
        "logs/{sample}_step1.log"
    shell:
        "tool_name -t {threads} -i {input} -o {output} 2> {log}"

rule step_2:
    """Second analysis step."""
    input:
        rules.step_1.output
    output:
        "output/{sample}.final_output"
    params:
        extra=config.get("extra_params", "")
    log:
        "logs/{sample}_step2.log"
    shell:
        "tool_name {params.extra} -i {input} -o {output} 2> {log}"
`;

export const DOCKERFILE_TEMPLATE = `FROM condaforge/miniforge3:latest

# Install bioinformatics tools
RUN conda install -y -c bioconda -c conda-forge \\
    snakemake-minimal \\
    bash \\
    curl \\
    # tool1=version \\
    # tool2=version \\
    && conda clean -afy

# Replace system bash with conda bash (prevents GLIBC mismatch)
RUN ln -sf /opt/conda/bin/bash /usr/bin/bash && \\
    ln -sf /opt/conda/bin/bash /bin/sh

# Install uv for fast Python package installation
RUN pip install uv

# Python packages (use uv instead of pip for faster dependency resolution)
# RUN uv pip install --system package1 package2

# Setup pipeline
WORKDIR /pipeline
COPY Snakefile .
COPY config.yaml .

CMD ["snakemake", "--help"]
`;

export const CONFIG_YAML_TEMPLATE = `# Required: list of sample names (without extension)
samples:
  - sample1
  - sample2

# Required: path to reference genome (mounted at runtime)
# reference: "/input/reference.fa"

# Optional: number of threads per rule (default: 4)
threads: 4

# Optional: additional parameters
# extra_params: ""
`;

export const RO_CRATE_METADATA_TEMPLATE = `{
  "@context": "https://w3id.org/ro/crate/1.1/context",
  "@graph": [
    {
      "@id": "ro-crate-metadata.json",
      "@type": "CreativeWork",
      "about": {"@id": "./"},
      "conformsTo": {"@id": "https://w3id.org/ro/crate/1.1"}
    },
    {
      "@id": "./",
      "@type": ["Dataset", "SoftwareSourceCode", "ComputationalWorkflow"],
      "name": "pipeline-name",
      "description": "One paragraph description of what this pipeline does.",
      "version": "1.0.0",
      "license": {"@id": "https://spdx.org/licenses/<SPDX_ID - ask the user before filling this in; recommend MIT if they are unsure>"},
      "programmingLanguage": {"@id": "#snakemake"},
      "creator": [{"@id": "#author"}],
      "dateCreated": "",
      "sdPublisher": {"@id": "https://hub.autopipe.org"},
      "isBasedOn": {"@id": ""},
      "softwareRequirements": [
        {"@id": "#tool1"},
        {"@id": "#tool2"}
      ],
      "input": [
        {"@id": "#input-fastq"},
        {"@id": "#input-fastq-gz"}
      ],
      "output": [
        {"@id": "#output-bam"},
        {"@id": "#output-vcf"}
      ],
      "keywords": ["tag1", "tag2"]
    },
    {
      "@id": "#author",
      "@type": "Person",
      "name": ""
    },
    {
      "@id": "#snakemake",
      "@type": "ComputerLanguage",
      "name": "Snakemake",
      "url": "https://snakemake.readthedocs.io"
    },
    {
      "@id": "#tool1",
      "@type": "SoftwareApplication",
      "name": "tool1"
    },
    {
      "@id": "#tool2",
      "@type": "SoftwareApplication",
      "name": "tool2"
    },
    {
      "@id": "#input-fastq",
      "@type": "FormalParameter",
      "name": "fastq",
      "encodingFormat": "application/x-fastq"
    },
    {
      "@id": "#input-fastq-gz",
      "@type": "FormalParameter",
      "name": "fastq.gz",
      "encodingFormat": "application/gzip"
    },
    {
      "@id": "#output-bam",
      "@type": "FormalParameter",
      "name": "bam",
      "encodingFormat": "application/x-bam"
    },
    {
      "@id": "#output-vcf",
      "@type": "FormalParameter",
      "name": "vcf",
      "encodingFormat": "text/x-vcf"
    }
  ]
}
`;

/**
 * Verbatim port of autopipe-app's `GENERATION_GUIDE` from
 * `crates/common/src/templates.rs`. Includes Pipeline Naming, Author
 * auto-fill, License Selection, Nextflow/Docker-socket safety check,
 * Upload Rules, and Safety Rules so the AI behaves identically to
 * autopipe-app.
 */
export const GENERATION_GUIDE = `# AutoPipe Pipeline Generation Guide

## Pipeline Structure
Every pipeline is a directory with 5 required files:
- Snakefile: Snakemake workflow
- Dockerfile: Execution environment
- config.yaml: Parameters
- ro-crate-metadata.json: Name, description, tools, I/O, tags
- README.md: Usage instructions

## Snakefile Rules
- Use \`configfile: "config.yaml"\` for all parameters
- Define \`rule all\` with final expected outputs
- Each rule = one logical analysis step
- Use \`threads\` directive for parallelizable steps
- Use \`log\` directive for capturing tool output
- Use \`expand()\` for sample-level parallelism

## Dockerfile Rules
- Base image: \`condaforge/miniforge3:latest\`
- Install bioconda/conda-forge tools via \`conda install -c bioconda -c conda-forge\`
- Always install \`snakemake-minimal\` and \`bash\` via conda
- After installing, replace system bash with conda bash to prevent GLIBC mismatch:
  \`RUN ln -sf /opt/conda/bin/bash /usr/bin/bash && ln -sf /opt/conda/bin/bash /bin/sh\`
- Pin tool versions for reproducibility (e.g., \`bwa=0.7.18\`)
- For Python (PyPI) packages, use \`uv pip install --system\` instead of \`pip install\`
  - Install uv first: \`RUN pip install uv\`
  - The \`--system\` flag is required to install into the conda environment
  - uv resolves dependencies much faster than pip
- Copy Snakefile and config.yaml into \`/pipeline\`
- Clean up: \`conda clean -afy\`
- Set \`WORKDIR /pipeline\`
- Do NOT use Docker commands (docker run, docker pull) directly inside Snakefile rules. The only exception is \`nextflow run\` with \`-profile docker\`, which manages its own containers through the mounted Docker socket.
- If converting from Nextflow or other container-based workflows, install all required tools from every container into the single Dockerfile.
- If the user already has a working Dockerfile from their analysis environment, use it as the base instead of writing one from scratch.

## config.yaml Rules
- ALL configurable parameters go here, not in Snakefile
- Include comments explaining each parameter
- Provide sensible defaults
- Mark required parameters with comments
- IMPORTANT: Use \`/input\` and \`/output\` as paths (Docker mount points)
  - Input data is mounted at \`/input\` (read-only) at runtime
  - Output directory is mounted at \`/output\` at runtime
  - Do NOT use absolute host paths like \`/home/user/data/...\`

## Pipeline Naming
- Before generating ro-crate-metadata.json, ask the user what name they want for their pipeline.
- This name will be displayed on the AutoPipe registry when published.

## Author (use GitHub login as default; do NOT prompt)
Read the \`GitHub: <login>\` line from \`get_workspace_info\` and use the login
as the **default** value for the \`#author\` node's \`name\` field. Do NOT ask
the user for an author name - the default is good enough for most users.
If the user explicitly says they want a different author (e.g., "publish
as 'Smith Lab'"), use what they specified instead.

If \`get_workspace_info\` shows \`GitHub: (not connected)\`: generate the
pipeline anyway with \`#author.name\` left empty, and tell the user once, in
chat, that they will need to complete the GitHub connection step in the
AutoPipe app before publishing. Do not block generation on this - when the
user later runs \`validate_pipeline\`, the validator will automatically fill
\`#author.name\` from the GitHub login once it is available, and will return
a clear error pointing back to the AutoPipe app if GitHub is still not
connected at that point.

## License Selection (ASK USER before generating ro-crate-metadata.json)
Before writing the metadata file, ask the user which open-source license to apply.
You MUST present ALL FIVE options below - do not collapse, omit, or summarise any
of them. Option 5 is REQUIRED so users with a non-listed license still know what to
do; never drop it because you assume the user will pick one of the first four.

Render the choices exactly like this (translate the prose into the user's chat
language but keep the SPDX identifiers and the URL verbatim):

  1. MIT - recommended default. The most permissive and widely-used license; pick
     this if you are unsure or unfamiliar with software licensing.
  2. BSD-3-Clause - permissive, similar to MIT with a no-endorsement clause.
  3. Apache-2.0 - permissive with an explicit patent grant.
  4. GPL-3.0 - copyleft; downstream forks must also be GPL-licensed.
  5. Other - look up the SPDX identifier of your preferred license at
     https://opensource.org/licenses and tell me which one to use.

If the user is unsure or asks for guidance, suggest MIT explicitly and explain
that it is the most permissive and widely-used license for open scientific
pipelines. Only proceed when the user has explicitly confirmed a choice.

Use the chosen SPDX identifier in the metadata's \`license\` field:
  "license": {"@id": "https://spdx.org/licenses/<SPDX_ID>"}

Examples:
  https://spdx.org/licenses/MIT
  https://spdx.org/licenses/BSD-3-Clause
  https://spdx.org/licenses/Apache-2.0
  https://spdx.org/licenses/GPL-3.0

## ro-crate-metadata.json (RO-Crate Format)
- Must follow RO-Crate 1.1 specification (JSON-LD)
- Dataset node requires: \`name\`, \`description\`, \`version\`, \`license\`
- \`creator\`: Person objects with \`name\` field
- \`softwareRequirements\`: SoftwareApplication objects with \`name\` field.
  ONLY include bioinformatics tools that directly analyze or process data in the Snakefile rules.
  Do NOT include programming languages, package managers, workflow engines, system libraries,
  or any infrastructure dependencies (Python, R, snakemake, conda, pip, etc.).
- \`input\` / \`output\`: FormalParameter objects with \`name\` and \`encodingFormat\`
- \`keywords\`: array of search tags
- \`programmingLanguage\`: always reference Snakemake

## README.md Content
- What the pipeline does (1-2 sentences)
- Required inputs with format description
- Expected outputs
- How to run (docker build + docker run commands)
- Configuration options from config.yaml

## Path Convention
- Pipelines always use Docker mount points for data paths:
  - \`/input\` - input data (mounted read-only at runtime)
  - \`/output\` - output directory (mounted at runtime)
  - \`/pipeline\` - pipeline files (Snakefile, config.yaml, etc.)
- Actual host paths are provided at execution time, not in pipeline files.
- Example in Snakefile: \`"input/{sample}.fastq.gz"\` (relative to Docker workdir)
- Example in config.yaml: \`reference: "/input/reference.fa"\`

## Nextflow / nf-core / Docker-in-Docker Support
When the pipeline uses nextflow, nf-core, or any command that runs Docker inside the container:
- BEFORE calling build_image, you MUST ask the user for confirmation:
  "This pipeline uses external containers (e.g., nf-core images) that are not inspected by AutoPipe.
   Running it requires mounting the host Docker socket. Proceed with build and execution?"
- If the user APPROVES: call build_image, then execute_pipeline with needs_docker_socket=true.
- If the user DECLINES: stop. Do NOT build or execute. Tell the user this pipeline cannot run
  without Docker socket access and ask if they want a different approach.
- Always use \`-profile docker\` for nextflow when approved.
- Install nextflow in the Dockerfile: \`RUN curl -s https://get.nextflow.io | bash && mv nextflow /usr/local/bin/\`
- CRITICAL: When needs_docker_socket=true, the environment variables HOST_INPUT_DIR, HOST_OUTPUT_DIR, and HOST_PIPELINE_DIR are automatically set inside the container with the actual host paths. In Snakefile rules that call nextflow or docker, ALWAYS use these variables instead of /input, /output, /pipeline. Also set NXF_HOME to $HOST_OUTPUT_DIR/.nextflow. Example:
  \`\`\`
  shell:
      """
      export NXF_HOME=$HOST_OUTPUT_DIR/.nextflow
      nextflow run nf-core/rnaseq -profile docker \\
          --input $HOST_INPUT_DIR/samplesheet.csv \\
          --outdir $HOST_OUTPUT_DIR/nfcore \\
          -w $HOST_OUTPUT_DIR/.nextflow/work
      """
  \`\`\`
  For non-nextflow rules in the same Snakefile, keep using /input, /output, /pipeline as usual.
- Keep everything in a single Snakefile + single Dockerfile as usual.

## Upload Rules
- When uploading a pipeline, ONLY include files that are part of the pipeline: Snakefile, Dockerfile, config.yaml, ro-crate-metadata.json, README.md, and any scripts/ or other files YOU created for this pipeline.
- NEVER include files or directories that were not created as part of the pipeline generation.
- Before calling upload_pipeline, verify the file list by checking what exists in the pipeline directory. Do NOT recursively include unrelated subdirectories.

## Safety Rules
1. Pipelines use Snakemake format. Nextflow is allowed only inside Snakefile rules via \`nextflow run\`.
2. Every pipeline must have a Dockerfile.
3. NEVER modify or delete user input data. Mount as read-only (:ro).
4. NEVER run destructive commands on user-provided paths.
5. NEVER hardcode absolute host paths in pipeline files.
6. NEVER use \`docker run\` or \`docker pull\` directly inside Snakefile rules.
`;
