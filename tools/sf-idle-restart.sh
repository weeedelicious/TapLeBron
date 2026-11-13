set -u
cd /data/wyx_root/tapflow-workbench
cat > /tmp/sf-imgbusy.js <<'JS'
const { getUsagePool } = require('/data/wyx_root/tapflow-workbench/server/db');
(async () => {
  const [rows] = await getUsagePool().query("SELECT COUNT(*) n FROM generation_tasks WHERE status IN ('submitted','running') AND task_type <> 'video' AND updated_at > NOW() - INTERVAL 30 MINUTE");
  const [recent] = await getUsagePool().query("SELECT COUNT(*) n FROM generation_tasks WHERE task_type <> 'video' AND created_at > NOW() - INTERVAL 40 SECOND");
  console.log('BUSY=' + rows[0].n + ' RECENT=' + recent[0].n);
  process.exit(0);
})().catch((e) => { console.log('ERR=' + e.message); process.exit(0); });
JS
chmod 644 /tmp/sf-imgbusy.js
for i in $(seq 1 180); do
  out=$(set -a; . ./.env; set +a; setpriv --reuid=tapflow --regid=tapflow --init-groups node /tmp/sf-imgbusy.js 2>/dev/null | tail -1)
  # 视频任务轮询阶段重启后能续上，但「下载完正在转 RV 兼容 MP4」这一步会被 SIGTERM 连 ffmpeg 一起杀掉、任务直接失败
  # （2026-11-13 canvas 498 任务 18276 就是这样丢的），所以服务进程组里还有 ffmpeg 时一律不重启
  cg=$(systemctl show tapflow-workbench -p ControlGroup --value)
  ff=0
  if [ -n "$cg" ] && [ -r "/sys/fs/cgroup$cg/cgroup.procs" ]; then
    for pid in $(cat "/sys/fs/cgroup$cg/cgroup.procs"); do
      [ "$(cat /proc/$pid/comm 2>/dev/null)" = ffmpeg ] && ff=$((ff+1))
    done
  fi
  out="$out FFMPEG=$ff"
  echo "$(date +%T) $out"
  if [ "$out" = "BUSY=0 RECENT=0 FFMPEG=0" ]; then
    oldpid=$(systemctl show tapflow-workbench -p MainPID --value)
    systemctl restart --no-block tapflow-workbench && echo RESTARTING old=$oldpid
    # 旧进程卡在 SSE 长连接上停不下来时（任务已确认是 0），45 秒后直接结束它
    for k in $(seq 1 9); do
      sleep 5
      kill -0 "$oldpid" 2>/dev/null || break
      [ "$k" = 9 ] && { echo "old pid stuck, kill -9 $oldpid"; kill -9 "$oldpid"; }
    done
    for j in $(seq 1 40); do
      sleep 5
      code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8084/Shotflow)
      if [ "$code" = "200" ]; then echo "HEALTH 200 after $((j*5))s; $(systemctl is-active tapflow-workbench)"; exit 0; fi
    done
    echo "HEALTH not 200: $code"; exit 1
  fi
  sleep 10
done
echo "STILL BUSY, not restarted"
