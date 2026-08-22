' Run a command fully hidden. wscript.exe is a GUI-subsystem app (never shows
' a console), and shell.Run with intWindowStyle=0 hides the child console app.
' Keep this file pure ASCII.
' Quoting rule: leave the executable bare, quote only args containing spaces
' (cmd/shell.Run reject a command line whose executable token is quoted).
Dim shell, i, cmd, arg
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  arg = WScript.Arguments(i)
  If InStr(arg, " ") > 0 Then
    arg = """" & arg & """"
  End If
  If Len(cmd) > 0 Then cmd = cmd & " "
  cmd = cmd & arg
Next
Set shell = CreateObject("WScript.Shell")
shell.Run cmd, 0, False
