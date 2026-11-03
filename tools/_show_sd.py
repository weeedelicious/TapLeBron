import subprocess
print(subprocess.run(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:8084/Shotflow"], capture_output=True, text=True).stdout)
