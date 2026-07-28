# HappyClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with full toolchain

FROM node:22.22.3-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752

# Install system packages (organized by category)
# NOTE: Keep this layer before the uv copy so tool updates do not invalidate
# this ~440MB layer. Debian packages intentionally follow the signed Bookworm
# repositories for security fixes; their transitive versions are not frozen.
# See issue #403.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # --- Browser & fonts ---
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    # --- Chromium shared library deps ---
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    # --- Build tools & compilers ---
    build-essential \
    cmake \
    pkg-config \
    # --- Python ecosystem ---
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    # --- Core CLI tools ---
    curl \
    wget \
    git \
    zsh \
    jq \
    tree \
    file \
    less \
    bc \
    patch \
    rsync \
    # --- Compression ---
    zip \
    unzip \
    xz-utils \
    bzip2 \
    # --- Network ---
    openssh-client \
    dnsutils \
    iputils-ping \
    # --- Process & system ---
    procps \
    lsof \
    # --- Text search & dev ---
    ripgrep \
    fd-find \
    shellcheck \
    # --- Multimedia ---
    ffmpeg \
    imagemagick \
    ghostscript \
    graphviz \
    # --- Document & PDF ---
    poppler-utils \
    pandoc \
    # --- Database clients ---
    sqlite3 \
    default-mysql-client \
    postgresql-client \
    redis-tools \
    # --- Locale ---
    locales \
    && rm -rf /var/lib/apt/lists/* \
    # Set up UTF-8 locale
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen \
    # Symlink fd-find → fd (Debian names it fdfind)
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd

# Copy the verified multi-arch uv release from its immutable manifest digest.
# Keeping it after apt-get avoids invalidating the heavy package layer when uv
# is deliberately upgraded. See issue #403.
COPY --from=ghcr.io/astral-sh/uv:0.11.16@sha256:440fd6477af86a2f1b38080c539f1672cd22acb1b1a47e321dba5158ab08864d /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:0.11.16@sha256:440fd6477af86a2f1b38080c539f1672cd22acb1b1a47e321dba5158ab08864d /uvx /usr/local/bin/uvx

# Locale environment
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Allow pip install without venv (Debian 12+ PEP 668) and add user bin to PATH
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV PATH="/home/node/.local/bin:${PATH}"

# Create app directory
WORKDIR /app

# Reproducible agent runtime: the verified SDK/CLI graph is locked and npm ci
# refuses to build if package.json and package-lock.json ever drift.
COPY agent-runner/package.json agent-runner/package-lock.json ./

# agent-browser is part of the committed dependency graph, so npm ci locks its
# full transitive tree. Expose the package-local CLI on the container PATH.
RUN npm ci \
    && ln -s /app/node_modules/.bin/agent-browser /usr/local/bin/agent-browser

# Headroom (https://github.com/chopratejas/headroom) - 工具输出/RAG/日志压缩.
# 装上 binary 但默认不启用——用户在 /mcp-servers 自行添加才生效, 配置:
#   { "command": "headroom", "args": ["mcp", "serve"] }
# 只选 [code,mcp] 两个 extras: [memory] 通过 sentence-transformers 强依赖
# torch + CUDA (cudnn-cu12, cublas, cusparse, cusolver, nccl, triton...),
# 压缩包就 ~2.45GB, 解包 3-6GB 量级. HappyClaw 容器无 GPU, 也不需要语义
# embedding 类 retrieve. 用户如真需要 headroom 的 memory 能力, 可在容器内
# 单独 `pip install --index-url https://download.pytorch.org/whl/cpu torch`
# 再 `pip install "headroom-ai[memory]"` 走 CPU 路径. PIP_BREAK_SYSTEM_PACKAGES
# 已在 line 103 设置, 这里无需再传 --break-system-packages.
# Pin 到已验证的 0.27.0：headroom-ai 仍是 PyPI Beta, 且 extras 解析
# 曾因 [memory]→torch 把镜像撑爆; `headroom --version` 自检只挡『装不上』挡不住
# 体积/行为漂移, 故锁定已验证的 ~550MB footprint, 仅允许 0.27.x 补丁更新.
RUN pip install "headroom-ai[code,mcp]==0.27.0" \
    && headroom --version

# Install the verified feishu-cli release. Its matching Skills are materialized
# on the host by scripts/install-host-tools.sh and then governed by the same
# EffectiveSkillManifest as every other runtime Skill.
# Checksums prevent a replaced or truncated download from entering the image.
ARG TARGETARCH
ARG FEISHU_CLI_VERSION=v1.35.0
ARG FEISHU_CLI_SHA256_AMD64=2bfd4e973add5674be92ec67c2f4948b656537a58ba6d04630c1ecda35121695
ARG FEISHU_CLI_SHA256_ARM64=9d7214916815242b9ea65984984b82f6ad215a52328968e4e799bcf136b795d6
RUN set -eu && \
    ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    case "$ARCH" in \
      amd64) BINARY_SHA256="$FEISHU_CLI_SHA256_AMD64" ;; \
      arm64) BINARY_SHA256="$FEISHU_CLI_SHA256_ARM64" ;; \
      *) echo "ERROR: unsupported feishu-cli architecture: $ARCH" >&2; exit 1 ;; \
    esac && \
    echo "Installing feishu-cli $FEISHU_CLI_VERSION for $ARCH" && \
    DOWNLOAD_TMP=$(mktemp -d) && \
    curl -fsSL --retry 3 \
      -o "$DOWNLOAD_TMP/feishu-cli.tar.gz" \
      "https://github.com/riba2534/feishu-cli/releases/download/${FEISHU_CLI_VERSION}/feishu-cli_${FEISHU_CLI_VERSION}_linux-${ARCH}.tar.gz" && \
    echo "$BINARY_SHA256  $DOWNLOAD_TMP/feishu-cli.tar.gz" | sha256sum -c - && \
    tar -xzf "$DOWNLOAD_TMP/feishu-cli.tar.gz" --strip-components=1 -C /usr/local/bin && \
    feishu-cli --version && \
    rm -rf "$DOWNLOAD_TMP"

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories. Long-term memory is host-managed and workspace
# scoped; legacy global/memory filesystem roots must not exist in the runtime.
RUN mkdir -p /workspace/group /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Copy entrypoint script (runs as root, drops to node user via runuser)
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Install a checksum-verified oh-my-zsh snapshot for node (ys theme). Failure is
# fatal: a successful image must never vary based on optional network timing.
ARG OH_MY_ZSH_COMMIT=677a4592b18c08ddea737f8aca70bac0e9fc9313
ARG OH_MY_ZSH_SHA256=f8c4c980bf28c77db703e083b5d395a2c42403abddbd36467c41a50a476fd841
RUN timeout -k 5 90 sh -c 'set -eu; \
      DOWNLOAD_TMP=$(mktemp -d); \
      curl -fsSL --retry 3 \
        -o "$DOWNLOAD_TMP/oh-my-zsh.tar.gz" \
        "https://github.com/ohmyzsh/ohmyzsh/archive/${OH_MY_ZSH_COMMIT}.tar.gz"; \
      echo "$OH_MY_ZSH_SHA256  $DOWNLOAD_TMP/oh-my-zsh.tar.gz" | sha256sum -c -; \
      tar -xzf "$DOWNLOAD_TMP/oh-my-zsh.tar.gz" -C "$DOWNLOAD_TMP"; \
      mv "$DOWNLOAD_TMP"/ohmyzsh-* /home/node/.oh-my-zsh; \
      cp /home/node/.oh-my-zsh/templates/zshrc.zsh-template /home/node/.zshrc; \
      sed -i '\''s/ZSH_THEME="robbyrussell"/ZSH_THEME="ys"/'\'' /home/node/.zshrc; \
      chown -R node:node /home/node/.oh-my-zsh /home/node/.zshrc; \
      chsh -s /bin/zsh node; \
      rm -rf "$DOWNLOAD_TMP"'

# Entrypoint runs as root to fix volume permissions, then drops to node user.
# Do NOT add USER node here — entrypoint handles the privilege drop.
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
