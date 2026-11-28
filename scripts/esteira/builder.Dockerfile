# Imagem dos jobs Linux do t3code na Esteira (homelab). Reproduz o que os
# runners ubuntu-24.04 do Fork Release usam: Node 24, Vite+, Rust, Java 17 e
# Android SDK. Construída no Docker rootless do usuário esteira:
#   docker build -t t3code-builder:1 -f scripts/esteira/builder.Dockerfile scripts/esteira
FROM node:24-bookworm

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && apt-get update && \
    apt-get install -y --no-install-recommends \
      git python3 build-essential pkg-config libsecret-1-dev imagemagick \
      curl ca-certificates unzip zip xz-utils file jq \
      openjdk-17-jdk-headless \
      libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libcups2 libxshmfence1
# (linha acima: runtime do Electron; o empacotamento executa o app para gerar o cache de compilação)

# Rust (helpers nativos do desktop: resource monitor, capture helpers).
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable && rustc --version

# Vite+ (vp) e o pnpm do packageManager (o empacotamento do desktop chama pnpm direto).
RUN npm install -g vite-plus@1.3.0 pnpm@11.10.0 && vp --version && pnpm --version

# Android SDK (+ build-tools para o apksigner do deploy). /opt/android-sdk vira volume de cache: o Gradle instala NDK e
# plataformas que faltarem uma vez só.
ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
RUN mkdir -p $ANDROID_HOME/cmdline-tools && cd /tmp && \
    curl -fsSLo tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip && \
    unzip -q tools.zip && mv cmdline-tools $ANDROID_HOME/cmdline-tools/latest && rm tools.zip && \
    yes | sdkmanager --licenses >/dev/null && sdkmanager "platform-tools" "build-tools;35.0.0" >/dev/null && sdkmanager --list_installed | head -5

WORKDIR /workspace
