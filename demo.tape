Output demo.gif

Set FontSize 16
Set Width 1200
Set Height 800
Set Theme "Catppuccin Mocha"
Set Padding 20

Hide

Type "export GITHUB_TOKEN=ghp_********" Enter
Sleep 500ms

Type "@|bold pr-slop check --repo curl/curl --pr 12345|@" Enter
Sleep 2s

Show

Sleep 1s

Type "npx pr-slop check --repo curl/curl --pr 12345" Enter
Sleep 3s

Output ""

Sleep 500ms
