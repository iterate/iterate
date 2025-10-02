FROM ubuntu:25.04

# Do all root operations first
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    unzip \
    sudo \
    && rm -rf /var/lib/apt/lists/* \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent

# Copy base setup script
COPY ./setup-ubuntu-base.sh /tmp/setup-ubuntu-base.sh
RUN chmod +x /tmp/setup-ubuntu-base.sh

# Set up non-root user and switch to it
RUN useradd -m -s /bin/bash agent
USER agent
WORKDIR /home/agent

# Set environment variables
ARG NODE_VERSION=24.4.1
ENV NODE_VERSION=${NODE_VERSION}
ENV CI=true
ENV NVM_DIR=/home/agent/.nvm
ENV PNPM_HOME=/home/agent/.local/share/pnpm
ENV PATH="/home/agent/.local/share/pnpm:$PATH"
ENV SHELL=/bin/bash

RUN /tmp/setup-ubuntu-base.sh

# Set the working directory to where code will be cloned
WORKDIR /home/agent
