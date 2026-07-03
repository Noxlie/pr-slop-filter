Output demo.gif

Set FontSize 16
Set Width 1000
Set Height 650
Set Theme "Catppuccin Mocha"
Set Padding 24

Hide

Type "set GITHUB_TOKEN=ghp_********" Enter
Sleep 500ms

Show

Type "node dist/cli/index.js check --repo facebook/react --pr 31000" Enter
Sleep 4s
Sleep 8s

Type "node dist/cli/index.js scan --repo facebook/react --threshold 30" Enter
Sleep 6s
Sleep 5s

Type "node dist/cli/index.js preflight" Enter
Sleep 3s
Sleep 5s
