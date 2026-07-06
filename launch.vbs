Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronBin = scriptDir & "\node_modules\.bin\electron.cmd"

If Not fso.FileExists(electronBin) Then
  MsgBox "Dependencies not installed. Run setup.bat first.", vbExclamation, "K7 Audio"
  WScript.Quit
End If

shell.CurrentDirectory = scriptDir
shell.Run """" & electronBin & """ .", 0, False
