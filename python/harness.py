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

3. For a LeetCode-style answer - a `class Solution` and no code that calls it -
   the result of calling it. The method is called on each test case, and what
   it RETURNS is reported, because a solution like that prints nothing and the
   return value is the whole answer. A design problem ("implement MinStack") is
   driven the same way LeetCode drives it: a list of operations and a list of
   their arguments, and the answer is what every call returned.

4. If the run is still going after LOOP_AFTER_S, where it is stuck: the line,
   the loop around it, and whether any of its variables are still changing.
   Then it ends itself. A blind kill from outside knew none of that.

Usage:  python harness.py <target.py> [cases.json]

cases.json is {"input": "<text>"}: the test cases, as LeetCode writes them -
`nums = [2,7,11,15], target = 9`, or one value per line.
"""

import ast
import inspect
import json
import os
import re
import sys
import threading
import time
import traceback
import types
from collections import deque

MAX_VARS = 40
MAX_REPR = 200

# Tracing limits. These bound the cost, and the cost is the reason they exist: a
# line event on every line of a tight loop is the difference between a run that
# feels instant and one that feels broken.
# The recording keeps both ends of a run and drops the middle.
#
# Keeping only the first N steps - which is what this did at first - is the
# wrong half. Setup is rarely where the bug is, and a wrong answer produced on
# the ten thousandth iteration fell off the end of the recording entirely. But
# a rolling window alone means tracing every line to the very end, and that is
# what makes a hot loop crawl. So: the head is kept whole, the tail rolls, and
# tracing gives up after a fixed slice of wall time - by which point either the
# program is nearly done or its middle was never going to be readable anyway.
KEEP_HEAD = 80         # the opening, kept exactly: arguments, setup, first pass
KEEP_TAIL = 220        # a rolling window on the end, where the answer is made
TRACE_BUDGET_S = 1.0   # wall time spent tracing before it switches itself off
BUDGET_EVERY = 2048    # events between clock checks; checking each one costs more

MAX_TRACE_VARS = 12    # names reported per step
MAX_TRACE_NAMES = 40   # names followed at all, per frame
MAX_TRACE_REPR = 120
MAX_ITEMS = 8          # elements shown before a container is summarised by length

# Prefixes the stderr lines carrying the captured values and the trace. The
# editor removes any line starting with one of these before the output is shown
# or parsed, so they must not look like anything Python itself prints.
VALUES_MARKER = "__MYIDE_VALUES__"
TRACE_MARKER = "__MYIDE_TRACE__"
RESULT_MARKER = "__MYIDE_RESULT__"
LOOP_MARKER = "__MYIDE_LOOP__"

# A practice solution on its example input finishes in milliseconds; LeetCode's
# own limit is about a second. Five is generous for honest work and short enough
# that a loop which never ends is reported before anyone wonders about it.
LOOP_AFTER_S = float(os.environ.get("MYIDE_LOOP_AFTER", "5"))
# A run that is not provably stuck may only be slow, and gets this long. Kept
# under the editor's hard limit (RUN_TIMEOUT_MS in main.js) so the report lands.
LOOP_GIVE_UP_S = float(os.environ.get("MYIDE_LOOP_GIVE_UP", "12"))
LOOP_SAMPLES = 3
LOOP_SAMPLE_GAP_S = 0.15
LOOP_EXIT_CODE = 124

MAX_CASES = 50
MAX_NODES = 10_000     # walking a returned linked list or tree, in case it loops
# What a design object holds after each call - its self.<name> values - is
# recorded for the first calls of the first cases: a pasted example is a dozen
# calls, and a thousand-call case would make the report megabytes.
STATE_OPS = 40
STATE_CASES = 10

# The names LeetCode's Python 3 environment provides without an import. Code
# pasted from there uses `List[int]` and `deque` freely, and would otherwise die
# with a NameError on the very first line - a failure that is ours, not theirs.
LEETCODE_PRELUDE = """\
from typing import *
import collections, heapq, bisect, itertools, functools, math, string, re, operator, random
from collections import deque, defaultdict, Counter, OrderedDict
from heapq import heappush, heappop, heapify, heappushpop, heapreplace, nlargest, nsmallest
from bisect import bisect, bisect_left, bisect_right, insort, insort_left, insort_right
from functools import lru_cache, reduce, cmp_to_key
from functools import cache
from itertools import accumulate, permutations, combinations, combinations_with_replacement, product, chain, groupby, zip_longest
from math import inf, gcd, sqrt, ceil, floor, log, log2, comb, factorial, isqrt
"""

SOLUTION_RE = re.compile(r"^class\s+Solution\b", re.MULTILINE)

# The prelude's own objects, by name, so they are not reported as the user's
# variables. Matched by identity as well as name: `inf = float("inf")` written
# by the user is theirs and is shown.
PRELUDE = {}


def summarise(value, limit=MAX_REPR):
    """A short, safe repr. A user object can raise from __repr__.

    A long string is cut before it is repr'd, not after: the repr of a string
    built up in a loop can be hundreds of megabytes, all of it thrown away.
    """
    try:
        if isinstance(value, str) and len(value) > limit:
            return repr(value[:limit]) + "..."
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
    if name.startswith("__") or isinstance(value, types.ModuleType):
        return False
    if name in PRELUDE and PRELUDE[name] is value:
        return False
    # `self` on a Solution is the same empty object every time - an address, no data.
    if name == "self" and type(value).__name__ == "Solution":
        return False
    return not (callable(value) and not hasattr(value, "__len__"))


MAX_SELF_ATTRS = 8


def named_values(items):
    """The (name, value) pairs worth showing, with `self` opened up into its attributes.

    A design problem's state is all on self - the stack, the cache, the head of
    the list - and `self` itself reprs as an address that never changes. So
    `self.stack` and `self.size` are shown instead, and change as it runs.
    """
    for name, value in items:
        if name == "self":
            try:
                attrs = list(vars(value).items())[:MAX_SELF_ATTRS]
            except TypeError:
                attrs = []   # no __dict__: __slots__, or a built-in
            for attr, item in attrs:
                if interesting(attr, item):
                    yield f"self.{attr}", item
            continue
        if interesting(name, value):
            yield name, value


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
        self.head = []
        self.tail = deque(maxlen=KEEP_TAIL)
        self.dropped = 0
        self.truncated = False
        self.done = False
        self.events = 0
        self.started = time.monotonic()
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

        for name, value in named_values(items):
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

        if len(self.head) < KEEP_HEAD:
            self.head.append(step)
        else:
            # Full deque: whatever it evicts is a step nobody will ever see,
            # and counting those is what lets the reader be told the middle is
            # missing rather than left to assume the run was short.
            if len(self.tail) == KEEP_TAIL:
                self.dropped += 1
            self.tail.append(step)

        self.events += 1
        if self.events % BUDGET_EVERY == 0:
            if time.monotonic() - self.started > TRACE_BUDGET_S:
                self.truncated = True
                self.done = True
                self.uninstall()

    @property
    def steps(self):
        return self.head + list(self.tail)

    def report(self):
        """One line on stderr, or nothing at all when nothing ran."""
        if not self.steps:
            return
        payload = {
            "steps": self.steps,
            "truncated": self.truncated,
            "dropped": self.dropped,
            # Where the gap falls, so the reader is shown it in the right place
            # rather than left to infer it from a jump in line numbers.
            "gapAt": len(self.head) if self.dropped else None,
            "limit": KEEP_HEAD + KEEP_TAIL,
        }
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
    for name, value in named_values(list(frame.f_locals.items())):
        if len(variables) >= MAX_VARS:
            break
        # brief, not summarise: a crash inside a loop over ten million items
        # would otherwise format all ten million to keep two hundred characters.
        variables[name] = brief(value, MAX_REPR)

    return {
        "line": frame_tb.tb_lineno,
        "function": frame.f_code.co_name,
        "locals": variables,
    }


# --- LeetCode-style solutions ---------------------------------------------------
#
# A `class Solution` with one method and no code calling it: LeetCode calls the
# method itself, on its own test cases, and compares what comes BACK. Run as a
# plain script it does nothing at all - "ran cleanly, printed nothing" - which
# is useless. So the harness does what LeetCode does.


class InputProblem(Exception):
    """The test case could not be read or does not fit the method. Not a bug in the code."""


def linked_values(node):
    """A linked list as LeetCode writes it, [1,2,3] - and safe on a list that loops."""
    out, seen = [], set()
    while node is not None and len(out) < MAX_NODES:
        if id(node) in seen:
            break
        seen.add(id(node))
        out.append(getattr(node, "val", None))
        node = getattr(node, "next", None)
    return out


def tree_values(root):
    """A binary tree in LeetCode's level order, nulls for the gaps, trailing nulls dropped."""
    out, queue, seen = [], deque([root]), set()
    while queue and len(out) < MAX_NODES:
        node = queue.popleft()
        if node is None or id(node) in seen:
            out.append(None)
            continue
        seen.add(id(node))
        out.append(getattr(node, "val", None))
        queue.append(getattr(node, "left", None))
        queue.append(getattr(node, "right", None))
    while out and out[-1] is None:
        out.pop()
    return out


def is_list_node(value):
    return hasattr(value, "val") and hasattr(value, "next") and not hasattr(value, "left")


def is_tree_node(value):
    return hasattr(value, "val") and hasattr(value, "left") and hasattr(value, "right")


class ListNode:
    """LeetCode's definition - which their template leaves commented out."""

    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

    def __repr__(self):
        # The rest of the list, not an address: in a trace "curr = ListNode(3 -> 4)"
        # is the whole story of a pointer walk, and <ListNode at 0x...> is none of it.
        values = linked_values(self)
        text = " -> ".join(summarise(v, 20) for v in values[:12])
        if len(values) > 12:
            text += f" -> ... {len(values)} nodes"
        return f"ListNode({text})"


class TreeNode:
    """LeetCode's definition - which their template leaves commented out."""

    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right

    def __repr__(self):
        values = tree_values(self)
        shown = ",".join("null" if v is None else summarise(v, 20) for v in values[:15])
        if len(values) > 15:
            shown += f",... {len(values)} slots"
        return f"TreeNode[{shown}]"


def leetcode_namespace():
    names = {}
    for line in LEETCODE_PRELUDE.splitlines():
        try:
            exec(line, names)
        except Exception:
            pass   # an older Python without functools.cache, say
    names.pop("__builtins__", None)
    names["ListNode"] = ListNode
    names["TreeNode"] = TreeNode
    return names


def build_list(values, cls):
    head = tail = None
    for v in values:
        node = cls(v)
        if head is None:
            head = node
        else:
            tail.next = node
        tail = node
    return head


def build_tree(values, cls):
    if not values or values[0] is None:
        return None
    root = cls(values[0])
    queue, i = deque([root]), 1
    while queue and i < len(values):
        node = queue.popleft()
        if i < len(values) and values[i] is not None:
            node.left = cls(values[i])
            queue.append(node.left)
        i += 1
        if i < len(values) and values[i] is not None:
            node.right = cls(values[i])
            queue.append(node.right)
        i += 1
    return root


def annotation_text(annotation):
    if annotation is inspect.Parameter.empty:
        return ""
    if isinstance(annotation, str):
        return annotation
    if isinstance(annotation, type):
        return annotation.__name__
    return str(annotation)


def convert(value, annotation, namespace):
    """Turns LeetCode's [1,2,3] into the ListNode or TreeNode the method expects."""
    text = annotation_text(annotation)
    for name, build in (("ListNode", build_list), ("TreeNode", build_tree)):
        if name not in text or not isinstance(value, list):
            continue
        cls = namespace.get(name, ListNode if name == "ListNode" else TreeNode)
        # List[Optional[ListNode]] - merge k sorted lists - is a list of lists.
        if re.match(r"(typing\.)?[Ll]ist\[", text) and all(isinstance(v, list) for v in value):
            return [build(v, cls) for v in value]
        return build(value, cls)
    return value


def plain(value):
    """A returned value as plain data, in LeetCode's own terms, or raises TypeError."""
    if is_tree_node(value):
        return tree_values(value)
    if is_list_node(value):
        return linked_values(value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if isinstance(value, (set, frozenset)):
        items = [plain(v) for v in value]
        try:
            return sorted(items)
        except TypeError:
            return items
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    raise TypeError(type(value).__name__)


def shown(value):
    """(text as LeetCode would show it, plain data or None when there is no plain form)."""
    try:
        data = plain(value)
        return json.dumps(data, separators=(",", ":"), ensure_ascii=False, allow_nan=False), data
    except (TypeError, ValueError, RecursionError):
        return summarise(value), None


def parse_value(text, annotation=inspect.Parameter.empty):
    """One value as LeetCode writes it: JSON, mostly, with Python's spelling allowed."""
    text = text.strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    try:
        return ast.literal_eval(text)
    except (ValueError, SyntaxError):
        pass
    if annotation_text(annotation) in ("str", "<class 'str'>"):
        return text   # an unquoted string, for a parameter that can only be a string
    raise InputProblem(f"could not read {text[:60]!r} as a value")


def split_top(text, separators=",\n"):
    """Splits at separators that are not inside brackets or quotes."""
    parts, buf, depth, quote, i = [], [], 0, None, 0
    while i < len(text):
        ch = text[i]
        if quote:
            buf.append(ch)
            if ch == "\\" and i + 1 < len(text):
                buf.append(text[i + 1])
                i += 1
            elif ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            buf.append(ch)
        elif ch in "[({":
            depth += 1
            buf.append(ch)
        elif ch in "])}":
            depth -= 1
            buf.append(ch)
        elif ch in separators and depth <= 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1
    parts.append("".join(buf))
    return [p.strip() for p in parts if p.strip()]


NAMED = re.compile(r"^([A-Za-z_]\w*)\s*=(?!=)\s*(.*)$", re.DOTALL)


def read_cases(text):
    """The input as a list of cases, each [(name or None, value text), ...]."""
    lines = []
    for line in text.replace("\r\n", "\n").split("\n"):
        # A whole example pasted in: keep the input, drop the rest.
        stripped = re.sub(r"^\s*Input\s*:\s*", "", line)
        if re.match(r"^\s*(Output|Explanation|Example\s*\d*)\s*:", stripped):
            continue
        lines.append(stripped)
    segments = split_top("\n".join(lines))
    if not segments:
        return []

    if not NAMED.match(segments[0]):
        return [[(None, s) for s in segments]]

    cases, current = [], []
    for segment in segments:
        m = NAMED.match(segment)
        if not m:
            raise InputProblem(f"expected name = value, found {segment[:60]!r}")
        name, value = m.group(1), m.group(2)
        # The same name again starts the next case: two examples pasted together.
        if any(n == name for n, _ in current):
            cases.append(current)
            current = []
        current.append((name, value))
    cases.append(current)
    return cases


def referenced_outside(tree, name):
    """Whether the file uses `name` anywhere but inside its own class.

    A student testing locally writes `print(Solution().twoSum([2, 7], 9))` under
    the class. Their own call is then the run: asking them for a test case, and
    switching away from the output they printed, answered a question nobody had.
    """
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == name:
            continue
        if any(isinstance(sub, ast.Name) and sub.id == name for sub in ast.walk(node)):
            return True
    return False


def definitions_only(tree):
    """Whether the file only defines things - the shape of a LeetCode answer.

    Imports, functions, classes, docstrings and constants (MOD = 10**9 + 7).
    Anything that calls something at the top level is a script, and runs as one.
    """
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef,
                             ast.ClassDef, ast.Pass)):
            continue
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
            continue
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and \
                not any(isinstance(sub, ast.Call) for sub in ast.walk(node)):
            continue
        return False
    return True


def solution_methods(cls, source):
    """The method LeetCode would call, first; helpers after.

    A helper is a method another method calls as self.name(...). The answer
    method calls itself when it recurses, so only calls from OTHER methods
    count. LeetCode's template method is otherwise the first one defined.
    """
    public = [name for name, raw in vars(cls).items()
              if not name.startswith("_") and callable(getattr(cls, name, None))]
    helpers = set()
    try:
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.ClassDef) and node.name == "Solution":
                for fn in node.body:
                    if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        continue
                    for sub in ast.walk(fn):
                        if (isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name)
                                and sub.value.id == "self" and sub.attr != fn.name):
                            helpers.add(sub.attr)
    except SyntaxError:
        pass
    return [n for n in public if n not in helpers] + [n for n in public if n in helpers]


def parameters(cls, name):
    raw = vars(cls).get(name)
    fn = getattr(cls, name)
    sig = inspect.signature(fn)
    params = list(sig.parameters.values())
    if not isinstance(raw, (staticmethod, classmethod)) and params:
        params = params[1:]   # self
    return params, sig.return_annotation


def describe_call(name, pairs):
    return f"{name}(" + ", ".join(f"{p} = {v}" for p, v in pairs) + ")"


class SolutionRun:
    """What has happened so far, for the report - including when a case raises."""

    def __init__(self):
        self.method = None
        self.params = []
        self.cases = []
        self.current = None
        # A design problem: "design", the class's public methods, and the
        # operations of the case in progress, so a crash or a stuck loop part
        # way through still shows the calls that came back before it.
        self.kind = None
        self.methods = None
        self.signatures = None
        self.partial = None

    def report(self, **extra):
        payload = {"method": self.method, "params": self.params, "cases": self.cases}
        if self.kind:
            payload["kind"] = self.kind
            payload["methods"] = self.methods or []
            payload["signatures"] = self.signatures or {}
        if self.partial:
            payload["partial"] = self.partial
        payload.update(extra)
        sys.stderr.write(RESULT_MARKER + json.dumps(payload) + "\n")
        sys.stderr.flush()


SOLUTION = SolutionRun()


def run_solution(namespace, source, input_text, self_called=False):
    """Calls Solution's method on every case, recording what each returns.

    `self_called`: the file calls Solution itself. With no cases given, that
    call is the whole run and nothing is added to it.
    """
    cls = namespace.get("Solution")
    if not isinstance(cls, type):
        return None
    names = solution_methods(cls, source)
    if not names:
        return None

    raw_cases = read_cases(input_text) if input_text.strip() else []
    if not raw_cases and self_called:
        return None
    if not raw_cases and not parameters(cls, names[0])[0]:
        raw_cases = [[]]   # a method with no arguments needs no input to be called

    # With names in the input, the method whose parameters they are.
    chosen = names[0]
    if raw_cases and raw_cases[0] and raw_cases[0][0][0] is not None:
        given = {n for n, _ in raw_cases[0]} - {"pos"}
        for name in names:
            if given <= {p.name for p in parameters(cls, name)[0]}:
                chosen = name
                break

    params, returns = parameters(cls, chosen)
    SOLUTION.method = chosen
    SOLUTION.params = [p.name for p in params]

    if not raw_cases:
        return {"needsInput": True}
    if design_cases(input_text):
        # Called with these, the method gets a list of names and a list of
        # lists, and fails somewhere inside the student's code - reported as
        # their bug, when it is the wrong problem's examples.
        raise InputProblem("this input is a list of operations, the way LeetCode writes a design "
                           "problem (MinStack, LRUCache, ...), and this file is a class Solution")

    cases = []
    for raw in raw_cases:
        if raw and raw[0][0] is None:
            # One value per line, as LeetCode's testcase box has it: as many
            # cases as there are whole sets of arguments.
            values = [v for _, v in raw]
            required = [p for p in params if p.default is inspect.Parameter.empty]
            width = len(params) if params and len(values) % len(params) == 0 else len(required)
            if not width or len(values) % width:
                raise InputProblem(
                    f"{chosen}() takes {len(params)} argument{'s' if len(params) != 1 else ''} "
                    f"({', '.join(SOLUTION.params)}) and the input has {len(values)} value"
                    f"{'s' if len(values) != 1 else ''}")
            for at in range(0, len(values), width):
                cases.append(list(zip([p.name for p in params], values[at:at + width])))
        else:
            cases.append(raw)

    for pairs in cases[:MAX_CASES]:
        by_name = {p.name: p for p in params}
        kwargs = {}
        pos = None
        for name, text in pairs:
            if name == "pos" and name not in by_name:
                pos = parse_value(text)   # LeetCode's cycle position for a linked list
                continue
            if name not in by_name:
                raise InputProblem(f"{chosen}() has no parameter called {name!r} - it takes "
                                   f"{', '.join(SOLUTION.params) or 'nothing'}")
            kwargs[name] = convert(parse_value(text, by_name[name].annotation),
                                   by_name[name].annotation, namespace)
        if isinstance(pos, int) and pos >= 0:
            for value in kwargs.values():
                if is_list_node(value):
                    nodes = []
                    node = value
                    while node is not None:
                        nodes.append(node)
                        node = node.next
                    if pos < len(nodes):
                        nodes[-1].next = nodes[pos]
                    break

        call = describe_call(chosen, pairs)
        SOLUTION.current = call
        first = next(iter(kwargs.values()), None)
        result = getattr(cls(), chosen)(**kwargs)
        SOLUTION.current = None

        # "Do not return anything, modify nums in-place": the answer is the
        # first argument, after the call.
        in_place = result is None and annotation_text(returns) == "None" and kwargs
        text, data = shown(first if in_place else result)
        entry = {"call": call, "shown": text, "value": data}
        if in_place:
            entry["inPlace"] = next(iter(kwargs))
        SOLUTION.cases.append(entry)

    return {"truncated": len(cases) > MAX_CASES}


# --- design problems -----------------------------------------------------------
#
# "Design a stack that supports push, pop, top and getMin": no Solution, a class
# of the student's own, driven by two lists LeetCode prints one above the other -
# the operations, and each one's arguments:
#
#     ["MinStack","push","push","getMin"]
#     [[],[-2],[0],[]]
#
# The first builds the object, and every one after calls a method on it. The
# answer is what every call returned, null for the ones that return nothing:
# [null,null,null,-2]. Run as a plain script a file like this does nothing, and
# "ran cleanly, printed nothing" is no use to anyone.

SECTION = re.compile(r"^\s*(Input|Output|Explanation|Example\s*\d*|Constraints|Note|Follow[- ]?up)\b\s*:?\s*",
                     re.IGNORECASE)


def design_cases(text):
    """The input as [(operations, arguments), ...] when it is in LeetCode's design form, else None.

    Takes the testcase box's two lines, or whole examples pasted from the
    problem - where "Input" and "Output" stand on lines of their own, and the
    Explanation under them is Java-ish prose that is not input at all.
    """
    kept, skipping = [], False
    for line in str(text or "").replace("\r\n", "\n").split("\n"):
        label = SECTION.match(line)
        if label:
            skipping = label.group(1).lower() != "input"
            line = line[label.end():]
        if not skipping and line.strip():
            kept.append(line)
    try:
        values = [parse_value(part) for part in split_top("\n".join(kept))]
    except InputProblem:
        return None
    if len(values) < 2 or len(values) % 2:
        return None
    cases = []
    for ops, args in zip(values[0::2], values[1::2]):
        if not (isinstance(ops, list) and ops and all(isinstance(op, str) for op in ops)):
            return None
        if not (isinstance(args, list) and len(args) == len(ops)):
            return None
        cases.append((ops, [a if isinstance(a, list) else [a] for a in args]))
    return cases


def public_methods(cls):
    return [name for name in vars(cls)
            if not name.startswith("_") and callable(getattr(cls, name, None))]


def design_class(namespace, tree):
    """The class a definitions-only file is about: the one with the most methods of its own.

    A design answer often defines a helper first - `class Node` for an LRU
    cache's linked list, `class TrieNode` - which has only __init__.
    """
    best = None
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            cls = namespace.get(node.name)
            count = len(public_methods(cls)) if isinstance(cls, type) else 0
            if count and (best is None or count > best[0]):
                best = (count, node.name, cls)
    return (best[1], best[2]) if best else (None, None)


def init_params(cls):
    try:
        return [p.name for p in list(inspect.signature(cls).parameters.values())]
    except (TypeError, ValueError):
        return []


def start_design(name, cls):
    SOLUTION.kind = "design"
    SOLUTION.method = name
    SOLUTION.methods = public_methods(cls)
    SOLUTION.params = init_params(cls)
    # Each method's parameter names, so "it needs a test case" can show one
    # written with this class's own names: [[capacity],[key],[key, value]].
    SOLUTION.signatures = {}
    for method in SOLUTION.methods:
        try:
            SOLUTION.signatures[method] = [p.name for p in parameters(cls, method)[0]]
        except (TypeError, ValueError):
            SOLUTION.signatures[method] = []


def op_text(op, args):
    return f"{op}(" + ", ".join(shown(a)[0] for a in args) + ")"


def design_label(ops, args, keep=8):
    calls = [op_text(op, a) for op, a in zip(ops, args)]
    if len(calls) > keep:
        calls = calls[:keep] + [f"... {len(calls) - keep} more"]
    return ", ".join(calls)


def run_design(namespace, cases, classes):
    """Builds the object and makes every call, recording what each returned."""
    name = cases[0][0][0]
    cls = namespace.get(name)
    if not (isinstance(cls, type) and name in classes):
        raise InputProblem(f"the operations start with {name!r}, and this file has no class called that"
                           + (f" - it has {', '.join(sorted(classes))}" if classes else ""))
    start_design(name, cls)

    for ops, args in cases[:MAX_CASES]:
        if ops[0] != name:
            raise InputProblem(f"each case starts by building {name}, and one starts with {ops[0]!r}")
        steps, plain, obj = [], True, None
        SOLUTION.partial = steps
        for at, (op, arg) in enumerate(zip(ops, args)):
            label = op_text(op, arg)
            SOLUTION.current = f"{label}, operation {at + 1} of {len(ops)}"
            if at == 0:
                obj = cls(*arg)
                result = None
            else:
                method = None if op.startswith("_") else getattr(obj, op, None)
                if not callable(method):
                    raise InputProblem(f"{name} has no method called {op!r} - it has "
                                       f"{', '.join(SOLUTION.methods) or 'none'}")
                result = method(*arg)
            text, data = shown(result)
            plain = plain and (data is not None or result is None)
            step = {"op": op, "args": label[len(op) + 1:-1], "shown": text, "value": data}
            if at < STATE_OPS and len(SOLUTION.cases) < STATE_CASES:
                # The object after the call. Where a wrong answer comes from is
                # nearly always a call before it that left the object wrong.
                step["state"] = {name: brief(value) for name, value in named_values([("self", obj)])}
            steps.append(step)
        SOLUTION.current = None
        SOLUTION.partial = None
        SOLUTION.cases.append({
            "call": design_label(ops, args),
            "shown": "[" + ",".join(s["shown"] for s in steps) + "]",
            "value": [s["value"] for s in steps] if plain else None,
            "ops": steps,
        })
    return {"truncated": len(cases) > MAX_CASES}


# --- a run that does not end ------------------------------------------------------


def user_chain(frame, target):
    """The user's frames on a stack, outermost first."""
    chain = []
    while frame is not None:
        if frame.f_code.co_filename == target:
            chain.append(frame)
        frame = frame.f_back
    chain.reverse()
    return chain


def enclosing_loop(source, line):
    """The innermost for/while containing `line`: its line, its condition, and the names in it.

    The names are the point. A while loop ends only when its condition changes,
    and its condition changes only when one of its names does - so "none of the
    names in `columnNumber > 0` changed" is the reason it cannot end, stated as
    a fact rather than guessed at.
    """
    best = None
    try:
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, (ast.For, ast.While, ast.AsyncFor)):
                end = getattr(node, "end_lineno", node.lineno)
                if node.lineno <= line <= end and (best is None or node.lineno > best.lineno):
                    best = node
    except SyntaxError:
        return None
    if best is None:
        return None
    test = best.test if isinstance(best, ast.While) else best.iter
    return {
        "line": best.lineno,
        "kind": "while" if isinstance(best, ast.While) else "for",
        "condition": ast.get_source_segment(source, test) or "",
        "names": sorted({n.id for n in ast.walk(test) if isinstance(n, ast.Name)}),
    }


def watchdog(main_id, target, source, tracer):
    """Reports where a run is stuck, then ends it.

    A loop that provably cannot end is stopped at LOOP_AFTER_S. Anything else
    may only be slow, so it is given until LOOP_GIVE_UP_S - still short of the
    editor's own hard limit, so the report always gets out first.
    """
    time.sleep(LOOP_AFTER_S)
    payload = look(main_id, target, source)
    if not payload.get("stuck"):
        time.sleep(max(0.0, LOOP_GIVE_UP_S - LOOP_AFTER_S - LOOP_SAMPLE_GAP_S * (LOOP_SAMPLES - 1)))
        payload = look(main_id, target, source)
        payload["seconds"] = LOOP_GIVE_UP_S

    tracer.done = True
    try:
        tracer.report()
    except Exception:
        pass
    if SOLUTION.method is not None:
        SOLUTION.report()   # the cases that did finish still have answers
    sys.stderr.write(LOOP_MARKER + json.dumps(payload) + "\n")
    sys.stderr.flush()
    sys.stdout.flush()
    os._exit(LOOP_EXIT_CODE)


def look(main_id, target, source):
    """Where the run is, and whether it can ever leave.

    Sampled a few times rather than once: whether the variables are still
    changing is the difference between "slow" and "can never finish". A loop
    whose every local is the same three checks running cannot reach a different
    outcome on the fourth.
    """
    samples = []
    for i in range(LOOP_SAMPLES):
        frame = sys._current_frames().get(main_id)
        chain = user_chain(frame, target)
        samples.append([(f, f.f_lineno, {n: brief(v) for n, v in named_values(list(f.f_locals.items()))})
                        for f in chain])
        if i < LOOP_SAMPLES - 1:
            time.sleep(LOOP_SAMPLE_GAP_S)

    # The deepest frame that was there every time: the one the loop is in. An
    # inner call that comes and goes each iteration is not where it is stuck.
    depth = 0
    while all(len(s) > depth for s in samples) and \
            all(s[depth][0] is samples[0][depth][0] for s in samples):
        depth += 1
    stable = depth - 1

    payload = {"seconds": LOOP_AFTER_S, "case": SOLUTION.current}
    if stable >= 0:
        frame, line, local = samples[-1][stable]
        first = samples[0][stable][2]
        changed = sorted(n for n in local if first.get(n) != local[n] or
                         any(s[stable][2].get(n) != local[n] for s in samples))
        loop = enclosing_loop(source, line)
        payload.update({
            "line": line,
            "loop": loop,
            "function": frame.f_code.co_name,
            "locals": dict(list(local.items())[:MAX_VARS]),
            "changed": changed,
            "lines": sorted({s[stable][1] for s in samples}),
        })
        # The verdict, from facts: a while loop whose condition names a local
        # variable, none of which moved while it was watched, is stuck. Anything
        # else - a for loop, a long sleep, a big sort - might only be slow, and
        # is reported as that.
        payload["stuck"] = False
        if loop and loop["kind"] == "while":
            watched = [n for n in loop["names"] if n in local]
            payload["stuck"] = bool(watched) and not any(n in changed for n in watched)
            payload["watched"] = watched
    return payload


def first_user_tb(tb, target):
    """The traceback from the user's first frame on - ours removed, however many there are."""
    while tb is not None and os.path.abspath(tb.tb_frame.f_code.co_filename) != target:
        tb = tb.tb_next
    return tb


def main():
    if len(sys.argv) < 2:
        print("harness.py <target> [cases.json]", file=sys.stderr)
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

    input_text = ""
    if len(sys.argv) > 2:
        try:
            with open(sys.argv[2], encoding="utf-8") as handle:
                input_text = str(json.load(handle).get("input") or "")
        except (OSError, ValueError, AttributeError):
            input_text = ""

    namespace = {"__name__": "__main__", "__file__": target, "__builtins__": __builtins__}
    # What shape of file this is decides what the run does after the file
    # itself has run: a Solution is called on its cases, a design class is
    # driven by its operations, anything else is a script and is left alone.
    tree = ast.parse(source)   # it compiled, so it parses
    classes = {node.name for node in tree.body if isinstance(node, ast.ClassDef)}
    solution = SOLUTION_RE.search(source) is not None
    design = None if solution else design_cases(input_text)
    shaped = bool(classes) and definitions_only(tree)
    # LeetCode's names (List, deque, ...) for anything shaped like an answer
    # from there: a design class's signatures use them as freely as a Solution's.
    if solution or shaped or (design and design[0][0][0] in classes):
        PRELUDE.update(leetcode_namespace())
        namespace.update(PRELUDE)
    tracer = Tracer(target)

    threading.Thread(target=watchdog, args=(threading.main_thread().ident, target, source, tracer),
                     daemon=True).start()

    outcome = None
    try:
        tracer.install()
        exec(code, namespace)
        if solution:
            outcome = run_solution(namespace, source, input_text,
                                   self_called=referenced_outside(tree, "Solution"))
        elif design:
            outcome = run_design(namespace, design, classes)
        elif shaped:
            name, cls = design_class(namespace, tree)
            if name:
                start_design(name, cls)
                if input_text.strip():
                    raise InputProblem(f"{name} is driven by a list of operations and a list of their "
                                       "arguments, as LeetCode writes them, and this input is not that")
                outcome = {"needsInput": True}
    except SystemExit as err:
        status = err.code if isinstance(err.code, int) else 0
    except InputProblem as err:
        tracer.uninstall()
        tracer.report()
        SOLUTION.report(inputError=str(err))
        return 0
    except BaseException as err:
        tracer.uninstall()
        user_tb = first_user_tb(err.__traceback__, target)

        # Raised by the call itself, before any of their code ran - the wrong
        # number of arguments, say. That is the input not fitting the method.
        if user_tb is None and SOLUTION.current is not None:
            tracer.report()
            SOLUTION.report(inputError=f"{type(err).__name__}: {err}")
            return 0

        info = capture(err.__traceback__, target)
        if info is not None:
            # Before the traceback, so a reader watching the output stream sees
            # the traceback arrive last and intact.
            sys.stderr.write(VALUES_MARKER + json.dumps(info) + "\n")
        tracer.report()
        if SOLUTION.method is not None:
            SOLUTION.report(failed=SOLUTION.current)

        # Drop our own frames so the traceback reads exactly as it would have
        # if Python had run the file directly - the editor parses this. For a
        # module-level error that is the exec frame; for a Solution method it
        # is everything that called it.
        tb = user_tb if user_tb is not None else err.__traceback__.tb_next
        sys.stderr.write("".join(traceback.format_exception(type(err), err, tb)))
        return 1
    else:
        status = 0
    finally:
        tracer.uninstall()

    tracer.report()
    if SOLUTION.method is not None:
        SOLUTION.report(**(outcome or {}))
    return status


if __name__ == "__main__":
    sys.exit(main())
