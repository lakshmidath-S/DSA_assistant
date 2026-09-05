"""Runs the user's file and records what the variables actually held.

Why this exists
---------------
Without it the model has to simulate the program in its head to explain a
failure, and it is not reliable at that. Asked about a wrong two_sum,
qwen2.5-coder:7b traced the loop correctly and then wrote that the result
"translates to [3, 0]" having just derived [1, 0]. Python knows the real values;
there is no reason to make a 7B model re-derive them.

So: run the file, and if it raises, report the locals of the deepest frame that
belongs to the user's own code. The traceback itself still goes to stderr in
exactly the format Python would have printed, because the editor parses it to
decide which line to mark.

The values go out on stderr too, as a single marker line, rather than to a side
file. A file needs somewhere writable, and there is no directory this process
can rely on: writes into the app's own data directory were silently discarded on
one machine while the same code worked from the project folder. stderr is
already open, already ours, and needs no cleanup. The editor strips the marker
line before showing anything.

Usage:  python harness.py <target.py>
"""

import json
import os
import sys
import traceback

MAX_VARS = 40
MAX_REPR = 200

# Prefixes the single stderr line carrying the captured values. The editor
# removes any line starting with this before the output is shown or parsed, so
# it must not look like anything Python itself prints.
VALUES_MARKER = "__MYIDE_VALUES__"


def summarise(value):
    """A short, safe repr. A user object can raise from __repr__."""
    try:
        text = repr(value)
    except BaseException:
        return "<repr failed>"
    if len(text) > MAX_REPR:
        return text[:MAX_REPR] + "..."
    return text


def deepest_user_frame(tb, target):
    """The last frame in the traceback that is the user's file, not ours."""
    target = os.path.abspath(target)
    found = None
    while tb is not None:
        if os.path.abspath(tb.tb_frame.f_code.co_filename) == target:
            found = tb
        tb = tb.tb_next
    return found


def capture(tb, target):
    frame_tb = deepest_user_frame(tb, target)
    if frame_tb is None:
        return None

    frame = frame_tb.tb_frame
    variables = {}
    for name, value in list(frame.f_locals.items()):
        if name.startswith("__") or len(variables) >= MAX_VARS:
            continue
        # Modules and functions are noise; the interesting things are data.
        if callable(value) and not hasattr(value, "__len__"):
            continue
        variables[name] = summarise(value)

    return {
        "line": frame_tb.tb_lineno,
        "function": frame.f_code.co_name,
        "locals": variables,
    }


def main():
    if len(sys.argv) < 2:
        print("harness.py <target>", file=sys.stderr)
        return 2

    # Normalise to the OS-native absolute form before anything else. The name
    # given to compile() is the one that appears in every traceback frame, and
    # the editor matches those against its own path to decide which frames are
    # the user's and to strip the path from the output panel. Passing
    # "C:/dir/main.py" through unchanged would print forward slashes where
    # Python itself prints backslashes, and both of those checks would miss.
    target = os.path.abspath(sys.argv[1])

    try:
        with open(target, encoding="utf-8") as handle:
            source = handle.read()
    except OSError as err:
        print(f"Could not read {target}: {err}", file=sys.stderr)
        return 2

    try:
        code = compile(source, target, "exec")
    except SyntaxError as err:
        # compile() fails before anything runs, so there are no values to
        # record - but the message must still look like Python's own.
        traceback.print_exception(type(err), err, None)
        return 1

    namespace = {"__name__": "__main__", "__file__": target, "__builtins__": __builtins__}

    try:
        exec(code, namespace)
    except SystemExit as err:
        return err.code if isinstance(err.code, int) else 0
    except BaseException as err:
        info = capture(err.__traceback__, target)
        if info is not None:
            # One line, before the traceback, so a reader watching the output
            # stream sees the traceback arrive last and intact.
            sys.stderr.write(VALUES_MARKER + json.dumps(info) + "\n")

        # Drop our own exec frame so the traceback reads exactly as it would
        # have if Python had run the file directly - the editor parses this.
        tb = err.__traceback__.tb_next
        sys.stderr.write("".join(traceback.format_exception(type(err), err, tb)))
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
