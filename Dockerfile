FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 dbus-x11 gnome-keyring libsecret-tools ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /smoke
COPY . .
RUN chown -R 1000:1000 /smoke
USER 1000:1000
CMD ["bash"]
