' MeetingMind Enterprise - silent launcher.
' No console window at any point: starts the backend with pythonw and opens
' Edge in app mode. Double-click this file (or a shortcut to it) to run.

Option Explicit

Const PORT = 3000
Const BASE_URL = "http://127.0.0.1:3000/"
Const STARTUP_TIMEOUT_MS = 20000

Dim fso, shell, appDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = appDir

' --- Is a healthy backend already up? -------------------------------------
If Not ServerIsHealthy() Then
    ' Something may be holding the port without answering (that was the old
    ' failure mode). Clear it out before starting a fresh instance.
    KillStaleServers
    If Not StartServer() Then WScript.Quit 1
    If Not WaitForServer(STARTUP_TIMEOUT_MS) Then
        MsgBox "MeetingMind: el servidor no respondio en " & (STARTUP_TIMEOUT_MS / 1000) & _
               " segundos." & vbCrLf & vbCrLf & "Revisa server_errors.log en:" & vbCrLf & appDir, _
               vbExclamation, "MeetingMind"
        WScript.Quit 1
    End If
End If

OpenApp

' --------------------------------------------------------------------------

Function ServerIsHealthy()
    Dim http
    ServerIsHealthy = False
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    If Err.Number <> 0 Then Exit Function
    http.SetTimeouts 2000, 2000, 2000, 3000
    http.Open "GET", BASE_URL & "api/db", False
    http.Send
    If Err.Number = 0 Then
        If http.Status = 200 Then ServerIsHealthy = True
    End If
    Err.Clear
    On Error GoTo 0
End Function

Function WaitForServer(timeoutMs)
    Dim waited
    waited = 0
    Do While waited < timeoutMs
        If ServerIsHealthy() Then
            WaitForServer = True
            Exit Function
        End If
        WScript.Sleep 400
        waited = waited + 400
    Loop
    WaitForServer = False
End Function

' Terminate any python/pythonw process still running server.pyw. Only called
' when the port is not answering, i.e. the process is already useless.
Sub KillStaleServers()
    Dim wmi, procs, p
    On Error Resume Next
    Set wmi = GetObject("winmgmts:\\.\root\cimv2")
    If Err.Number <> 0 Then Exit Sub
    Set procs = wmi.ExecQuery( _
        "SELECT ProcessId, CommandLine FROM Win32_Process " & _
        "WHERE Name = 'pythonw.exe' OR Name = 'python.exe'")
    For Each p In procs
        If Not IsNull(p.CommandLine) Then
            If InStr(LCase(p.CommandLine), "server.pyw") > 0 Then
                p.Terminate
            End If
        End If
    Next
    Err.Clear
    On Error GoTo 0
    WScript.Sleep 500
End Sub

Function StartServer()
    Dim pythonw
    pythonw = FindPythonW()
    If pythonw = "" Then
        MsgBox "MeetingMind: no se encontro Python en este equipo." & vbCrLf & vbCrLf & _
               "Descargalo desde https://www.python.org/downloads/ y, durante la" & vbCrLf & _
               "instalacion, marca la casilla ""Add Python to PATH""." & vbCrLf & vbCrLf & _
               "No hace falta ninguna otra libreria.", vbCritical, "MeetingMind"
        StartServer = False
        Exit Function
    End If
    ' Window style 0 = hidden, so no terminal ever appears.
    shell.Run """" & pythonw & """ """ & fso.BuildPath(appDir, "server.pyw") & """", 0, False
    StartServer = True
End Function

' Locate a Python interpreter without assuming anything about this machine.
' Nothing here is hardcoded to a particular install path or version number.
Function FindPythonW()
    Dim roots, dirs, d, candidate, i
    FindPythonW = ""

    ' 1. PATH first, so the launcher follows whatever Python the user set up.
    dirs = Split(shell.ExpandEnvironmentStrings("%PATH%"), ";")
    For i = 0 To UBound(dirs)
        d = Trim(dirs(i))
        If d <> "" Then
            candidate = fso.BuildPath(d, "pythonw.exe")
            ' WindowsApps holds the Store stub, which is not a real interpreter.
            If fso.FileExists(candidate) And InStr(LCase(candidate), "\windowsapps\") = 0 Then
                FindPythonW = candidate
                Exit Function
            End If
        End If
    Next

    ' 2. The official Windows launcher. The python.org installer drops pyw.exe
    '    into the Windows folder whether or not "Add Python to PATH" was ticked,
    '    and it accepts the same arguments as pythonw.exe.
    candidate = shell.ExpandEnvironmentStrings("%SystemRoot%\pyw.exe")
    If fso.FileExists(candidate) Then
        FindPythonW = candidate
        Exit Function
    End If

    ' 3. Standard install roots, scanned rather than listed version by version.
    roots = Array( _
        shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\Python"), _
        shell.ExpandEnvironmentStrings("%PROGRAMFILES%"), _
        shell.ExpandEnvironmentStrings("%PROGRAMFILES(X86)%"), _
        "C:\")
    For i = 0 To UBound(roots)
        candidate = FindInRoot(roots(i))
        If candidate <> "" Then
            FindPythonW = candidate
            Exit Function
        End If
    Next
End Function

' Look for pythonw.exe one level below rootPath, keeping the highest version
' found so Python313 wins over Python312.
Function FindInRoot(rootPath)
    Dim folder, child, candidate, bestName
    FindInRoot = ""
    bestName = ""

    On Error Resume Next
    If Not fso.FolderExists(rootPath) Then
        On Error GoTo 0
        Exit Function
    End If
    Set folder = fso.GetFolder(rootPath)
    If Err.Number <> 0 Then
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If

    For Each child In folder.SubFolders
        candidate = fso.BuildPath(child.Path, "pythonw.exe")
        If fso.FileExists(candidate) Then
            If LCase(child.Name) > bestName Then
                bestName = LCase(child.Name)
                FindInRoot = candidate
            End If
        End If
    Next
    Err.Clear
    On Error GoTo 0
End Function

' Opens a chromeless app window in Edge. Falls back to the default browser.
Sub OpenApp()
    Dim edge
    edge = FindEdge()
    If edge = "" Then
        shell.Run BASE_URL, 1, False
    Else
        shell.Run """" & edge & """ --app=" & BASE_URL, 1, False
    End If
End Sub

Function FindEdge()
    Dim paths, i
    FindEdge = ""
    On Error Resume Next
    FindEdge = shell.RegRead("HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe\")
    Err.Clear
    On Error GoTo 0
    If FindEdge <> "" Then
        If fso.FileExists(FindEdge) Then Exit Function
    End If
    paths = Array( _
        "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", _
        "C:\Program Files\Microsoft\Edge\Application\msedge.exe")
    For i = 0 To UBound(paths)
        If fso.FileExists(paths(i)) Then
            FindEdge = paths(i)
            Exit Function
        End If
    Next
    FindEdge = ""
End Function
