/** Bounded child output capture shared by fixed remote helpers. */
export const REMOTE_PROCESS_CAPTURE = String.raw`
import selectors, time, signal

def capture_require(value):
    if not value: raise ValueError('bounded process operation failed')

def capture(command, env, limit=2097152, timeout=15):
    # Drain both pipes incrementally, kill the entire child group on any bound.
    child = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selected = selectors.DefaultSelector(); output = bytearray(); total = 0; deadline = time.monotonic() + timeout; completed = False
    try:
        for pipe in [child.stdout, child.stderr]:
            os.set_blocking(pipe.fileno(), False); selected.register(pipe, selectors.EVENT_READ)
        while selected.get_map():
            remaining = deadline - time.monotonic()
            capture_require(remaining > 0)
            for key, _ in selected.select(min(remaining, 0.1)):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data: selected.unregister(key.fileobj); continue
                total += len(data); capture_require(total <= limit)
                if key.fileobj is child.stdout: output.extend(data)
        capture_require(child.wait(timeout=max(0.01, deadline-time.monotonic())) == 0)
        completed = True
        return output.decode('utf-8')
    finally:
        selected.close()
        if not completed:
            try: os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            child.wait()
        child.stdout.close(); child.stderr.close()
`;
