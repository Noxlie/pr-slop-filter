Output demo.gif

Set FontSize 16
Set Width 1000
Set Height 650
Set Theme "Catppuccin Mocha"
Set Padding 24

Hide

Type "export GITHUB_TOKEN=ghp_********" Enter
Sleep 500ms
Type "clear" Enter
Sleep 300ms

Show

Type "npx pr-slop check --repo facebook/react --pr 31000" Enter
Sleep 4s

Sleep 8s

Type "clear" Enter
Sleep 300ms

Type "npx pr-slop scan --repo facebook/react --threshold 30" Enter
Sleep 6s

Sleep 5s

Type "clear" Enter
Sleep 300ms

Type "npx pr-slop preflight" Enter
Sleep 3s

Sleep 5s
