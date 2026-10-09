#!/bin/sh
# 随身 Agent 盘 · 安全提交并推送
#
# 每次改完都用它提交:它会先检查"将要提交的内容"里有没有密钥、口令、内网地址,
# 以及私密路径有没有被误跟踪 —— 通过才 commit + push。
# 直接用 git push 会绕过这层检查(曾经因此把内网地址推到了公开仓库)。
#
# 用法:
#   sh tools/commit-push.sh "提交说明"
#   sh tools/commit-push.sh --force "提交说明"   # 重写过历史(清理敏感内容)后必须用
#   sh tools/commit-push.sh                  # 用默认说明
set -e
cd "$(dirname "$0")/.."

FORCE=0
if [ "$1" = "--force" ] || [ "$1" = "-f" ]; then FORCE=1; shift; fi
MSG=${1:-"更新"}
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)

git add -A

# ── ① 私密路径绝不能被跟踪 ──
BAD=""
for p in data/config/secrets.json data/config/passphrase data/config/providers.json; do
  if git ls-files --error-unmatch "$p" >/dev/null 2>&1; then BAD="$BAD $p"; fi
done
if git ls-files | grep -q '^data/home/'; then BAD="$BAD data/home/"; fi
if [ -n "$BAD" ]; then
  echo "✗ 这些私密路径被 git 跟踪了,已中止:$BAD"
  echo "  修复:git rm --cached <路径>,并确认 .gitignore 里有对应规则"
  exit 1
fi

# ── ② 扫描将要提交的内容 ──
# 注意 git grep 的参数位置:必须写成 `git grep --cached -lE -e <模式>`。
# 若写成 `git grep -lE "<模式>" --cached`,--cached 会被当成**路径参数**,
# 结果什么文件都没搜到、永远返回"通过" —— 这个坑踩过,安全网形同虚设。
FOUND=""
for pat in \
  '192\.168\.[0-9]' \
  '10\.[0-9]+\.[0-9]+\.[0-9]+' \
  '172\.1[6-9]\.' '172\.2[0-9]\.' '172\.3[01]\.' \
  'sk-[A-Za-z0-9_-]{20,}' \
  'Bearer [A-Za-z0-9_.-]{20,}'
do
  HITS=$(git grep --cached -lE -e "$pat" 2>/dev/null || true)
  if [ -n "$HITS" ]; then FOUND="$FOUND
    $pat → $HITS"; fi
done
# 自检:确认扫描逻辑本身有效(临时塞入一个必然命中的模式,必须能搜到)
SELFTEST=$(git grep --cached -lE -e 'e' 2>/dev/null | head -1 || true)
if [ -z "$SELFTEST" ]; then
  echo "✗ 扫描逻辑自检失败(搜不到任何文件),为避免误判为'通过'而中止"
  exit 1
fi
# 本机若存在真实口令,也一并纳入扫描(不打印它的内容)
if [ -f data/config/passphrase ]; then
  LOCALPASS=$(cat data/config/passphrase 2>/dev/null || true)
  if [ -n "$LOCALPASS" ]; then
    HITS=$(git grep --cached -lF -e "$LOCALPASS" 2>/dev/null || true)
    if [ -n "$HITS" ]; then FOUND="$FOUND
    (本机密钥库口令) → $HITS"; fi
  fi
fi
if [ -n "$FOUND" ]; then
  echo "✗ 扫描发现可疑内容,已中止(暂存已保留,不会提交):"
  echo "$FOUND"
  echo "  确认是误报再手动提交;要撤销暂存:git reset"
  exit 1
fi

echo "  ✓ 扫描通过:无密钥 / 口令 / 内网地址,私密路径未被跟踪"

# ── ③ 提交并推送 ──
if [ -z "$(git diff --cached --name-only)" ]; then
  echo "  没有需要提交的改动;若只是未推送,执行 git push"
  exit 0
fi
git diff --cached --stat | tail -1
git commit -q -m "$MSG"

# 推送:必须检查退出码 —— 之前把输出接给 tail 就报告"已推送",
# 实际推送被拒也看不出来。
if [ "$FORCE" = "1" ]; then
  PUSH_OUT=$(GIT_TERMINAL_PROMPT=0 git push --force-with-lease origin "$BRANCH" 2>&1) && PUSH_OK=1 || PUSH_OK=0
else
  PUSH_OUT=$(GIT_TERMINAL_PROMPT=0 git push origin "$BRANCH" 2>&1) && PUSH_OK=1 || PUSH_OK=0
fi
echo "$PUSH_OUT" | tail -4
if [ "$PUSH_OK" = "0" ]; then
  case "$PUSH_OUT" in
    *non-fast-forward*|*rejected*|*fetch\ first*)
      echo "  ✗ 推送被拒:远端有本地没有的提交。"
      echo "    若本地是重写过的历史(例如清理了敏感内容),用:sh tools/commit-push.sh --force \"说明\""
      echo "    否则先 git pull --rebase 再推。"
      ;;
    *) echo "  ✗ 推送失败,见上面信息。" ;;
  esac
  exit 1
fi
echo "  ✓ 已提交并推送到 origin/$BRANCH  ($(git rev-parse --short HEAD))"
