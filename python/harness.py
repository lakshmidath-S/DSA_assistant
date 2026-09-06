"""Runs the user's file, records what the variables held, and traces the path.

Why this exists
---------------
Without it the model has to simulate the program in its head to explain a
failure, and it is not reliable at that. Asked about a wrong two_sum,
qwen2.5-coder:7b traced the loop correctly and then wrote that the result
"translates to [3, 0]" having just derived [1, 0]. Python knows the real values;
there is no reason to make a 7B model re-derive them.

So: run the file, and report two things.

1. If it raises, the locals of the deepest frame that belongs to the user's own
   code. The traceback itself still goes to stderr in exactly the format Python
   would have printed, because the editor parses it to decide which line to mark.

2. Either way, the path the program actually took: a bounded history of
   (line, the names that changed). An exception handler cannot give this - a run
   that finishes and prints the wrong answer never raises, and that is the case
   this app exists for. Only `sys.settrace` sees it.

Both go out on stderr, as single marker lines, rather than to side files. A file
needs somewhere writable, and there is no directory this process can rely on:
writes into the app's own data directory were silently discarded on one machine
while the same code wrote fine from the project folder. stderr is already open,
already ours, and needs no cleanup. The editor strips the marker lines before
showing anything.

Usage:  python harness.py <target.py>
"""

import json
import os
import sys
import traceback

MAX_VARS = 40
MAX_REPR = 200

# Tracing limits. These bound the cost, and the cost is the reason they exist: a
# line event on every line of a tight loop is the difference between a run that
# feels instant and one that feels broken.
MAX_STEPS = 300        # after this, tracing is switched off, not merely ignored
MAX_TRACE_VARS = 12    # names reported per step
MAX_TRACE_NAMES = 40   # names followed at all, per frame
MAX_TRACE_REPR = 120
MAX_ITEMS = 8          # elements shown before a container is summarised by length

# Prefixes the stderr lines carrying the captured values and the trace. The
# editor removes any line starting with one of these before the output is shown
# or parsed, so they must not look like anything Python itself prints.
VALUES_MARKER = "__MYIDE_VALUES__"
TRACE_MARKER = "__MYIDE_TRACE__"


def summarise(value, limit=MAX_REPR):
    """A short, safe repr. A user object can raise from __repr__."""
    try:
        text = repr(value)
    except BaseException:
        return "<repr failed>"
    if len(text) > limit:
        return text[:limit] + "..."
    return text


def brief(value, limit=MAX_TRACE_REPR):
    """summarise(), but it never builds the whole repr of a big container.

    The tracer reprs every visible name on every recorded line, so a list of ten
    thousand elements would otherwise be formatted in full, three hundred times,
    only to be cut to a hundred characters. Formatting the first few elements
    costs the same whatever the length - and reads better besides, because
    "... 10000 items" is more use than a hundred characters of the first few.
    """
    try:
        if isinstance(value, (str, bytes)):
            return summarise(value, limit)

        if isinstance(value, dict):
            if len(value) > MAX_ITEMS:
                head = ", ".join(
                    f"{summarise(k, 24)}: {summarise(v, 24)}"
                    for k, v in list(value.items())[:MAX_ITEMS]
                )
                return "{" + head + ", ... " + str(len(value)) + " keys}"
        elif isinstance(value, (list, tuple, set, frozenset)):
            if len(value) > MAX_ITEMS:
                if isinstance(value, list):
                    open_, close = "[", "]"
                elif isinstance(value, tuple):
                    open_, close = "(", ")"
                else:
                    open_, close = "{", "}"
                head = ", ".join(summarise(v, 24) for v in list(value)[:MAX_ITEMS])
                return f"{open_}{head}, ... {len(value)} items{close}"
    except BaseException:
        # len() and iteration are both user code on a user type.
        return "<repr failed>"

    return summarise(value, limit)


def interesting(name, value):
    """Data is worth recording; the imports and the functions are noise."""
    if name.startswith("__"):
        return False
    return not (callable(value) and not hasattr(value, "__len__"))


def describe_exception(arg):
    """The `(type, value, traceback)` an exception event carries, as one line."""
    try:
        kind, value = arg[0], arg[1]
        return f"{kind.__name__}: {str(value)[:100]}"
    except BaseException:
        return "raised"


class Tracer:
    """Records the path the program took, and what changed on each line.

    Only the user's own frames are traced: the global trace function returns
    None for everything else, so the standard library and our own code run at
    full speed and never appear in the history.

    Recording stops at MAX_STEPS by uninstalling the trace function, rather than
    by continuing to pay for events that will be thrown away. A run whose
    beginning has been recorded is worth having; a run that took twenty seconds
    because it was watched to the end is not.

    A line event fires BEFORE that line runs, so a step reads: "about to run
    line L, and these names changed since the previous step". The changes on a
    step are therefore the effect of the step before it, which is what makes a
    scrubber legible - the highlighted line is the one about to happen, and the
    values beside it are what it is about to happen to.
    """

    def __init__(self, target):
        self.target = target
        self.steps = []
        self.truncated = False
        self.done = False
        self.depth = 0
        # Keyed by id(frame): the depth it was called at, and the last repr seen
        # for each name, so a step can report only what changed.
        self.frames = {}

    def install(self):
        sys.settrace(self.on_call)

    @staticmethod
    def uninstall():
        sys.settrace(None)

    def on_call(self, frame, event, arg):
        """The global trace function: decides whether a frame is worth watching."""
        if self.done or frame.f_code.co_filename != self.target:
            return None
        self.depth += 1
        self.frames[id(frame)] = {"depth": self.depth, "seen": {}}
        return self.on_event

    def on_event(self, frame, event, arg):
        """The per-frame trace function.

        It must never raise: an exception thrown here unsets tracing and then
        surfaces in the middle of the user's own traceback, which is the one
        thing in this program that has to stay byte for byte correct.
        """
        try:
            return self.handle(frame, event, arg)
        except Exception:
            self.done = True
            self.uninstall()
            return None

    def handle(self, frame, event, arg):
        state = self.frames.get(id(frame))
        if self.done or state is None:
            return None

        if event == "line":
            # Reaching a line means the exception, if any, was handled.
            state.pop("raised", None)
            self.record({
                "line": frame.f_lineno,
                "fn": frame.f_code.co_name,
                "d": state["depth"],
                "vars": self.changes(frame, state),
            })

        elif event == "exception":
            # Which line actually raised - including one that is then caught and
            # swallowed, a real source of wrong answers and invisible in a
            # traceback precisely because it never reached one.
            state["raised"] = True
            self.record({
                "line": frame.f_lineno,
                "fn": frame.f_code.co_name,
                "d": state["depth"],
                "exc": describe_exception(arg),
            })

        elif event == "return":
            # "r" marks the frame ending, separately from the value it ended
            # with: a module frame and a frame left by an exception both end
            # without one, and the viewer has to know the scope closed so a
            # later call at the same depth does not inherit its variables.
            step = {"line": frame.f_lineno, "fn": frame.f_code.co_name, "d": state["depth"], "r": 1}
            # A frame left by an exception also reports "return", with None.
            # Recording that as the return value would be a lie.
            if not state.get("raised") and frame.f_code.co_name != "<module>":
                step["ret"] = brief(arg)
            self.record(step)
            self.depth -= 1
            self.frames.pop(id(frame), None)

        return self.on_event

    def changes(self, frame, state):
        """The names whose value has changed since this frame's previous step.

        Compared by repr rather than by identity or equality: `graph[u].append(v)`
        mutates a list in place, so the object is the same one it was before and
        `is` sees nothing happen. The repr is what the reader and the model are
        shown, so the repr is the right thing to diff.
        """
        seen = state["seen"]
        changed = {}

        try:
            items = list(frame.f_locals.items())
        except Exception:
            return changed

        for name, value in items:
            if not interesting(name, value):
                continue
            if name not in seen and len(seen) >= MAX_TRACE_NAMES:
                continue
            text = brief(value)
            if seen.get(name) != text:
                seen[name] = text
                changed[name] = text
                if len(changed) >= MAX_TRACE_VARS:
                    break

        return changed

    def record(self, step):
        if not step.get("vars"):
            step.pop("vars", None)
        self.steps.append(step)
        if len(self.steps) >= MAX_STEPS:
            self.truncated = True
            self.done = True
            self.uninstall()

    def report(self):
        """One line on stderr, or nothing at all when nothing ran."""
        if not self.steps:
            return
        payload = {"steps": self.steps, "truncated": self.truncated, "limit": MAX_STEPS}
        sys.stderr.write(TRACE_MARKER + json.dumps(payload) + "\n")


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
        if not interesting(name, value) or len(variables) >= MAX_VARS:
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
    # The tracer matches on it too, by identity against co_filename.
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
        # compile() fails before anything runs, so there is nothing to record -
        # but the message must still look like Python's own.
        traceback.print_exception(type(err), err, None)
        return 1

    namespace = {"__name__": "__main__", "__file__": target, "__builtins__": __builtins__}
    tracer = Tracer(target)

    try:
        tracer.install()
        exec(code, namespace)
    except SystemExit as err:
        status = err.code if isinstance(err.code, int) else 0
    except BaseException as err:
        tracer.uninstall()
        info = capture(err.__traceback__, target)
        if info is not None:
            # Before the traceback, so a reader watching the output stream sees
            # the traceback arrive last and intact.
            sys.stderr.write(VALUES_MARKER + json.dumps(info) + "\n")
        tracer.report()

        # Drop our own exec frame so the traceback reads exactly as it would
        # have if Python had run the file directly - the editor parses this.
        tb = err.__traceback__.tb_next
        sys.stderr.write("".join(traceback.format_exception(type(err), err, tb)))
        return 1
    else:
        status = 0
    finally:
        tracer.uninstall()

    tracer.report()
    return status


if __name__ == "__main__":
    sys.exit(main())
