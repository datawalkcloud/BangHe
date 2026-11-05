# 官网（site/）静态托管镜像。
# 构建上下文是仓库根（context: .），站点是纯静态文件，无需 Node 构建。
# 本地构建（推 ACR 必须关掉 provenance，否则会带上 ACR 不认的 OCI 附件）：
#   docker build --provenance=false --sbom=false -f deploy/site/Dockerfile -t banghe-site .
FROM nginx:1.27-alpine

# 整份替换 nginx.conf：监听 8080、非 root、pid 与临时目录落在 /tmp
COPY deploy/site/nginx.conf /etc/nginx/nginx.conf
COPY site/ /usr/share/nginx/html/

EXPOSE 8080

# 以 nginx 用户运行，配合 k8s 的 runAsNonRoot / readOnlyRootFilesystem
USER nginx

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

# 官方镜像的 entrypoint 会尝试改 /etc/nginx/conf.d，非 root 下必然失败，故直接覆盖
ENTRYPOINT ["nginx", "-g", "daemon off;"]
