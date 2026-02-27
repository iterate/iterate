FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    sshfs openssh-server fuse3 git \
    && rm -rf /var/lib/apt/lists/*

# Setup SSH for loopback sshfs
RUN mkdir -p /run/sshd && \
    ssh-keygen -A && \
    useradd -m -s /bin/bash testuser && \
    echo 'testuser:testpass' | chpasswd && \
    mkdir -p /home/testuser/.ssh && \
    ssh-keygen -t ed25519 -f /home/testuser/.ssh/id_ed25519 -N '' && \
    cp /home/testuser/.ssh/id_ed25519.pub /home/testuser/.ssh/authorized_keys && \
    chown -R testuser:testuser /home/testuser/.ssh && \
    chmod 700 /home/testuser/.ssh && \
    chmod 600 /home/testuser/.ssh/authorized_keys

RUN echo 'user_allow_other' >> /etc/fuse.conf

RUN corepack enable && corepack prepare pnpm@9 --activate

# Clone the iterate repo and install deps on LOCAL disk at build time.
# This gives us a realistic node_modules tree with thousands of files.
# If the repo is private/unavailable, we generate a synthetic tree instead.
RUN git clone --depth 1 https://github.com/iterate/iterate.git /opt/iterate 2>/dev/null && \
    cd /opt/iterate && \
    (pnpm install --frozen-lockfile 2>/dev/null || pnpm install) && \
    rm -rf /root/.local/share/pnpm/store || \
    echo "Repo clone failed — will use synthetic tree instead"

# Also generate a synthetic tree that guarantees we have enough files
# even if the clone above failed or node_modules is small.
# Structure mimics node_modules: deeply nested dirs with small files.
RUN mkdir -p /opt/synthetic-tree && \
    cd /opt/synthetic-tree && \
    for i in $(seq 1 100); do \
      dir="node_modules/pkg-$i/lib/dist/src"; \
      mkdir -p "$dir"; \
      for j in $(seq 1 50); do \
        echo "// pkg-$i file $j" > "$dir/file-$j.js"; \
        echo "{}" > "$dir/file-$j.d.ts"; \
      done; \
    done && \
    echo "Synthetic tree created with $(find . -type f | wc -l) files"

# Create a directory to serve via sshfs
RUN mkdir -p /srv/fuse-data && chown testuser:testuser /srv/fuse-data

COPY test.sh /test.sh
RUN chmod +x /test.sh

CMD ["/test.sh"]
