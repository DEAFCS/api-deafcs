# mediamtx-camera

Dedicated MediaMTX instance for the tournament "camera required"
feature. See the comments in [`mediamtx-camera.yml`](./mediamtx-camera.yml)
for why this is a separate instance from the production `mediamtx`
(GOTV/live-match streaming) rather than a shared one.

## Deploying

Requires kubectl access to the cluster (`deafcs-vps` SSH host).

```bash
kubectl create configmap mediamtx-camera-config \
  --from-file=mediamtx.yml=mediamtx-camera.yml \
  -n 5stack \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f mediamtx-camera.deployment.yaml
```

(The ConfigMap is applied separately via `--from-file` — same as the
existing `mediamtx-config-*`/POC's `mediamtx-webcam-config` pattern —
so editing `mediamtx-camera.yml` and re-running the command above is
enough to push a config change; the inline ConfigMap in
`mediamtx-camera.deployment.yaml` is a placeholder kept only so the
file is self-describing.)

## Firewall

One additive UFW rule is required on the VPS (doesn't touch any
existing rules for api/web/game-server/production-mediamtx):

```bash
sudo ufw allow 8191/udp
```

(`8891/tcp` does **not** need a UFW rule — it's only reached over the
cluster-internal Service by api-deafcs pods, never from the public
internet. Only the raw WebRTC media on `8191/udp` needs to reach the
VPS's public IP directly.)

## Verifying

```bash
kubectl get pods -n 5stack -l app=mediamtx-camera
kubectl logs -n 5stack -l app=mediamtx-camera --tail=50
```

Health/readiness: `curl http://mediamtx-camera.5stack.svc.cluster.local:9998/v3/paths/list`
from inside the cluster (e.g. from an api-deafcs pod), or via the
same SSH-tunnel technique used for Hasura (see
`[[deafcs-hasura-metadata-access]]` in Claude's memory) pointed at
port 9998 instead of 8080.

## Tearing down

```bash
kubectl delete deployment mediamtx-camera -n 5stack
kubectl delete service mediamtx-camera -n 5stack
kubectl delete configmap mediamtx-camera-config -n 5stack
sudo ufw delete allow 8191/udp
```
