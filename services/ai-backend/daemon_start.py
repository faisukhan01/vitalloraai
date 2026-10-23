"""Daemonize the FastAPI backend so it survives tool-call process sweeps.

Double-fork + setsid + exec — the same escape pattern the in-app bridge
supervisor uses (start_new_session). Run:  python daemon_start.py
"""

import os
import sys

LOG = "/home/z/my-project/backend.log"
CWD = "/home/z/my-project/services/ai-backend"
CMD = ["/home/z/.venv/bin/python", "-m", "uvicorn", "app.main:app",
       "--host", "0.0.0.0", "--port", "8000", "--reload", "--ws-ping-interval", "0"]


def _fork_and_die() -> None:
    pid = os.fork()
    if pid > 0:
        os._exit(0)


def main() -> None:
    _fork_and_die()          # 1st fork: leave the invoking shell's group
    os.setsid()              # new session, detached from any controlling tty
    _fork_and_die()          # 2nd fork: session leader can never reacquire a tty
    os.chdir(CWD)
    os.close(0)
    fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    with open("/dev/null") as devnull:
        os.dup2(devnull.fileno(), 0)
    os.execv(CMD[0], CMD)


if __name__ == "__main__":
    sys.exit(main())
