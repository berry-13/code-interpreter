import sys as ______sys
# Hide the workspace from this template's OWN imports, mirroring the session
# bootstrap (see session-persist.ts): with persistence, a prior run can leave
# e.g. `logging.py` in /mnt/data, and these setup imports would otherwise
# resolve that carried-over file and brick every later plotting run before
# user code even starts. sys.path is restored right after the last template
# import below, so user code resolves its own workspace modules as usual.
# Unlike the bootstrap there is NO sys.modules eviction afterwards: user
# imports must get the SAME cached matplotlib whose pyplot module object is
# patched below (a fresh re-import would lose the show/savefig patches), and
# matplotlib lazily imports more of itself at gcf()/savefig() time, so its
# transitive deps must stay cached for the patched helpers to keep working
# mid-run. The cost -- a workspace module named like one of these deps is
# shadowed by the real one for pyplot runs -- matches the pre-persistence
# template, which also imported them before the user block.
______saved_path = list(______sys.path)
______sys.path[:] = [______p for ______p in ______sys.path if ______p not in ('', '/mnt/data')]
import os as ______os
import logging as ______logging
from types import SimpleNamespace as ______SimpleNamespace

# All of this template's own helper imports are `______`-prefixed -- not just
# for the namespace/functions below -- so persistent-session snapshots (which
# exclude every `______`-prefixed global) never capture them. Unprefixed names
# like `os` or `plt` would otherwise be ordinary module-level globals in the
# same namespace user code runs in: once any plotting run bound them, they'd
# get snapshotted as module aliases and silently overwrite a user variable of
# the same name (e.g. a prior run's own `os = ...`) on every later restore,
# pyplot or not, for the rest of the session.
______ns = ______SimpleNamespace()

# Set up logging
try:
    ______logging.basicConfig(level=______logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
    ______ns.logger = ______logging.getLogger(__name__)
except Exception as e:
    print(f"Failed to set up logging: {e}")
    ______sys.exit(1)

# Set the environment variables BEFORE importing matplotlib
try:
    ______os.environ['MPLBACKEND'] = 'Agg'
    ______os.environ['MPLCONFIGDIR'] = '/tmp/matplotlib'  # Required: sandbox has no home dir
except Exception as e:
    ______ns.logger.error(f"Failed to set environment variables: {e}")
    ______sys.exit(1)

# Set backend BEFORE importing pyplot (more reliable than env var)
import matplotlib as ______matplotlib
______matplotlib.use('Agg')

# Optimize matplotlib settings BEFORE importing pyplot
______matplotlib.rcParams.update({
    'figure.dpi': 100,              # Reasonable default (user can override)
    'savefig.dpi': 150,             # Cap savefig DPI for performance
    'figure.max_open_warning': 0,   # Disable warning spam
    'axes.formatter.useoffset': False,
    'font.family': 'DejaVu Sans',   # Use a font that's pre-cached
    'text.usetex': False,           # Disable LaTeX (slow)
    'svg.fonttype': 'none',         # Don't embed fonts in SVG
})

import matplotlib.pyplot as ______plt

# Last template import done -- give user code back its normal import path.
______sys.path[:] = ______saved_path

# Seed the counter past any plot_N.png already in the workspace. With persistent
# sessions a prior run's plots are restored into the cwd, so starting from 0
# would make plt.show() rewrite plot_1.png and clobber the earlier figure. When
# persistence is off the workspace is empty, so this is a no-op (counter stays 0).
# `______`-prefixed locals are excluded from the persisted namespace snapshot.
______ns.plot_counter = 0
try:
    for ______name in ______os.listdir('.'):
        if ______name.startswith('plot_') and ______name.endswith('.png'):
            ______stem = ______name[len('plot_'):-len('.png')]
            if ______stem.isdigit():
                ______ns.plot_counter = max(______ns.plot_counter, int(______stem))
except Exception:
    pass
______ns.saved_figures = set()

def ______custom_show():
    """Custom function to replace plt.show()"""
    global ______ns
    current_fig = ______plt.gcf()

    if current_fig.number not in ______ns.saved_figures:
        ______ns.plot_counter += 1
        filename = f"plot_{______ns.plot_counter}.png"
        current_fig.savefig(filename)
        ______ns.logger.info(f"Plot saved as {filename}")
        ______ns.saved_figures.add(current_fig.number)
    else:
        ______ns.logger.info(f"Figure {current_fig.number} has already been saved, skipping save operation")

    ______plt.close(current_fig)

# Override plt.show and plt.savefig. Mutating the module object's own
# attributes (via the `______plt` alias) patches the exact same singleton
# module the user's own `import matplotlib.pyplot as plt` resolves to, so the
# patch takes effect under whatever name the user's code uses.
______plt.show = ______custom_show

# `______`-prefixed so persistent-session snapshots exclude it (the snapshot
# filter drops underscore-prefixed names) and it can't clobber a user variable.
______original_savefig = ______plt.savefig

# Maximum DPI to prevent excessive rendering time
______MAX_DPI = 200

def ______custom_savefig(*args, **kwargs):
    current_fig = ______plt.gcf()
    ______ns.saved_figures.add(current_fig.number)

    # Cap DPI to prevent performance issues
    if 'dpi' in kwargs and kwargs.get('dpi', 0) > ______MAX_DPI:
        ______ns.logger.debug(f"Capping DPI from {kwargs['dpi']} to {______MAX_DPI}")
        kwargs['dpi'] = ______MAX_DPI

    return ______original_savefig(*args, **kwargs)

______plt.savefig = ______custom_savefig

# Re-expose the canonical `plt` alias: /v1/exec code routed through this
# template has always been able to call `plt.show()` without its own
# `import matplotlib.pyplot as plt`, and dropping the binding entirely (when
# the template's helpers moved to `______`-prefixed names) broke e.g.
# `import seaborn as sns; ...; plt.show()` with a NameError. Guarded so a
# RESTORED user binding named `plt` is never clobbered -- with persistence,
# this module scope runs AFTER the wrapper has restored the prior namespace
# into these same globals, and the unguarded module-level `plt` was removed
# for exactly that overwrite hazard (see header comment). When we do bind
# it, later snapshots simply record a module alias, the same as if the user
# had imported pyplot themselves.
if 'plt' not in globals():
    plt = ______plt

# User code runs directly at module scope (inside this `if`, not a function
# body) so it shares the real module globals rather than a nested local scope.
# A `def main(): ...` wrapper here would make every name the user assigns
# resolve as a function-local, so a persistent-session continuation like
# `x += 1` on a restored global raises UnboundLocalError (the read half of
# the augmented assignment can't see the enclosing global). Running at
# module scope also means there is nothing to promote afterwards: the
# snapshot (which reads globals()/the module dict directly) already sees
# everything the user assigned, with or without persistence enabled.
if __name__ == "__main__":
    # BEGIN USER CODE
    # User code will be inserted here
    # END USER CODE