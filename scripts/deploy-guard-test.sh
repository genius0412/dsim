#!/usr/bin/env bash
# THE PRODUCTION DEPLOY GUARD, EXERCISED. `bash scripts/deploy-guard-test.sh` (a few seconds).
#
# fly-deploy.sh refuses to deploy production from anything but a clean commit on main
# (`require_main_tree`). This runs its `--check` in throwaway repositories for every case the
# rule has: main, a detached release worktree, a rollback, an unpushed commit, another branch,
# uncommitted and untracked files, the override, and the two cross-wired app names.
#
# `fly` is a stub that fails loudly, first on PATH: a case that got past the check and reached a
# deploy shows as FLY CALLED and fails. Nothing here can touch a real app. Run it after any change
# to the top of fly-deploy.sh; `npm run test:mm` only holds that the guard is still asked first.
set -u
SCRIPT="$(cd "$(dirname "$0")" && pwd)/fly-deploy.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
printf '#!/usr/bin/env bash\necho "FLY CALLED: $*"\nexit 99\n' > "$T/bin/fly"
chmod +x "$T/bin/fly"
export PATH="$T/bin:$PATH"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/work" 2>/dev/null
cd "$T/work" || exit 2
git checkout -q -b main
echo one > a.txt && git add a.txt && git commit -q -m one 2>/dev/null
echo two > a.txt && git commit -q -am two 2>/dev/null
git push -q origin main

fails=0
run() { # name, wanted exit code, a pattern its output must hold, then env pairs and the command
  local name="$1" want="$2" pat="$3"
  shift 3
  local out rc
  out=$(env "$@" 2>&1)
  rc=$?
  if [ "$rc" -eq "$want" ] && echo "$out" | grep -q -- "$pat" && ! echo "$out" | grep -q "FLY CALLED"; then
    echo "PASS  $name"
  else
    echo "FAIL  $name (exit $rc, wanted $want) :: $(echo "$out" | tr '\n' ' ' | cut -c1-220)"
    fails=$((fails + 1))
  fi
}

run "a pushed commit on branch main is allowed" 0 "ok to deploy PRODUCTION from main" bash "$SCRIPT" --check
git checkout -q --detach origin/main
run "a detached HEAD at origin/main is allowed (a release worktree)" 0 "ok to deploy PRODUCTION" bash "$SCRIPT" --check
git checkout -q --detach origin/main~1
run "an older commit of main is allowed (a rollback)" 0 "ok to deploy PRODUCTION" bash "$SCRIPT" --check
git checkout -q main
echo three > a.txt && git commit -q -am three 2>/dev/null
run "a commit on main that was not pushed is refused" 1 "not a commit on origin/main" bash "$SCRIPT" --check
run "...and DEPLOY_ANY_TREE=1 lets it through, saying so" 0 "DEPLOY_ANY_TREE=1: PRODUCTION from main" DEPLOY_ANY_TREE=1 bash "$SCRIPT" --check
git reset -q --hard origin/main
git checkout -q -b alpha
echo alpha > b.txt && git add b.txt && git commit -q -m alpha 2>/dev/null
run "another branch (alpha) is refused, by name" 1 "this tree is alpha @" bash "$SCRIPT" --check
run "...but --alpha is not asked about main" 0 "ok to deploy the alpha preview from alpha" bash "$SCRIPT" --alpha --check
run "--alpha onto the production app is refused" 1 "FLY_ALPHA_APP names the PRODUCTION app" FLY_ALPHA_APP=dohun-sim-decode bash "$SCRIPT" --alpha --check
git checkout -q main
echo dirty > a.txt
run "a tracked file with uncommitted changes is refused, and named" 1 "a.txt" bash "$SCRIPT" --check
git checkout -q -- a.txt
echo scratch > untracked.txt
run "an untracked file does not block a deploy" 0 "ok to deploy PRODUCTION" bash "$SCRIPT" --check
run "production's config onto the alpha app is refused" 1 "FLY_APP names the alpha app" FLY_APP=dsim-alpha bash "$SCRIPT" --check
mkdir -p "$T/plain" && cd "$T/plain" || exit 2
run "a directory that is not a git checkout is refused" 1 "not a git checkout" bash "$SCRIPT" --check

echo
[ "$fails" -eq 0 ] && echo "ALL PASS (12 cases)" || echo "$fails FAILED"
exit "$fails"
