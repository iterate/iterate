FROM ubuntu:25.04

# Do all root operations first
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    unzip \
    sudo \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent

# Copy setup scripts
COPY ./setup-ubuntu-base.sh /tmp/setup-ubuntu-base.sh
COPY ./docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /tmp/setup-ubuntu-base.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

# Set up non-root user and switch to it
RUN useradd -m -s /bin/bash agent
USER agent
WORKDIR /home/agent

# Set environment variables before installation
ARG NODE_VERSION=24.4.1
ENV NODE_VERSION=${NODE_VERSION}
ENV CI=true
ENV NVM_DIR=/home/agent/.nvm
ENV PNPM_HOME=/home/agent/.local/share/pnpm
ENV SHELL=/bin/bash

# Run the setup script
RUN /tmp/setup-ubuntu-base.sh

# Update PATH after installation to include both pnpm and NVM
ENV PATH="${PNPM_HOME}:${NVM_DIR}/versions/node/v${NODE_VERSION}/bin:${PATH}"

# Create a shell initialization script that ensures NVM and pnpm are always available
RUN echo '#!/bin/bash' > /home/agent/.bash_env && \
    echo 'export NVM_DIR="$HOME/.nvm"' >> /home/agent/.bash_env && \
    echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> /home/agent/.bash_env && \
    echo 'export PNPM_HOME="$HOME/.local/share/pnpm"' >> /home/agent/.bash_env && \
    echo 'export PATH="$PNPM_HOME:$PATH"' >> /home/agent/.bash_env && \
    chmod +x /home/agent/.bash_env && \
    echo 'source ~/.bash_env' >> /home/agent/.bashrc

# Verify installations
RUN bash -c "source ${NVM_DIR}/nvm.sh && node --version && pnpm --version"

# Set bash as the default shell and ensure it sources the environment
ENV BASH_ENV=/home/agent/.bash_env

# Set the working directory to where code will be cloned
WORKDIR /home/agent

# Set the entrypoint to start Docker daemon
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/bin/bash"]