Output docs/demo/frames/

Require pnpm

Set Shell "bash"
Set FontSize 17
Set Width 1180
Set Height 440
Set Theme "Builtin Dark"
Set TypingSpeed 35ms

Hide
Type "export PS1='$ ' LOG_LEVEL=silent && clear"
Enter
Show

Sleep 600ms
Type "pnpm -s run review:github:commit -- --owner gkosach --repo test-mr"
Sleep 500ms
Enter
Sleep 1500ms

Hide
Wait+Screen@600s /Published as a GitHub Check/
Show

Sleep 8s
