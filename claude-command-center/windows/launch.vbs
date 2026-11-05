' Opens the Claude Command Center dashboard without a console window.
' Argument --background only starts the backend (used at sign-in).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
action = "open"
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "--background" Then action = "start"
End If
sh.Run "node """ & appDir & "\cli\ccc.js"" " & action, 0, False
