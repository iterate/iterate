FROM ubuntu:22.04

# Set up non-root user as recommended for background agents
RUN useradd -m -s /bin/bash ubuntu
USER ubuntu
WORKDIR /home/ubuntu

# Install basic dependencies
USER root

RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    unzip \
    sudo \
    && rm -rf /var/lib/apt/lists/* \
    && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu

# Copy base setup script
COPY ./setup-ubuntu-base.sh /tmp/setup-ubuntu-base.sh
RUN chmod +x /tmp/setup-ubuntu-base.sh

# Switch back to ubuntu user
USER ubuntu

# Set environment variables
ARG NODE_VERSION=24.4.1
ENV NODE_VERSION=${NODE_VERSION}
ENV CI=true
ENV NVM_DIR=/home/ubuntu/.nvm
ENV PNPM_HOME=/home/ubuntu/.local/share/pnpm
ENV PATH="/home/ubuntu/.local/share/pnpm:$PATH"
ENV SHELL=/bin/bash

# Run the base setup script
RUN /tmp/setup-ubuntu-base.sh

# Set the working directory to where code will be cloned
WORKDIR /home/ubuntu