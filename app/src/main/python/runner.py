"""在 Chaquopy 里执行原版脚本：把 argv、工作目录、stdout 都接好。"""
import io
import json
import os
import runpy
import sys
import contextlib
import traceback


def run(script, args, cwd):
    """执行一个脚本，返回 {"code": int, "out": str}。"""
    old_cwd = os.getcwd()
    old_argv = list(sys.argv)
    buf = io.StringIO()
    code = 0
    try:
        if cwd:
            os.chdir(cwd)
        sys.argv = [script] + list(args or [])
        sys.path.insert(0, os.path.dirname(script))
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            try:
                runpy.run_path(script, run_name="__main__")
            except SystemExit as e:
                code = int(e.code or 0)
            except Exception:
                code = 1
                buf.write(traceback.format_exc())
    finally:
        os.chdir(old_cwd)
        sys.argv = old_argv
    return json.dumps({"code": code, "out": buf.getvalue()}, ensure_ascii=False)


def version():
    return sys.version
