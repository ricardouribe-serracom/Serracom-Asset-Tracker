Attribute VB_Name = "ChatPullRedTags"
' Serracom CHAT Request Form helper.
' Reads the CSV from the app's "Export CHAT" button and fills the Order form and Justification tabs.
' Only typing cells are filled. Formula columns C (Asset Returned Required) and F (Request date) are never touched.
' A serial that's already on the Order form is skipped, so running it twice doesn't add lines twice.
Option Explicit

Public Sub PullRedTags()
    Dim f As Variant, lines As Collection, hdr As Object, i As Long
    f = Application.GetOpenFilename("CHAT export (*.csv),*.csv", , "Pick the CHAT file from the Serracom app")
    If VarType(f) = vbBoolean Then Exit Sub

    Set lines = ReadLines(CStr(f))
    If lines.Count < 2 Then MsgBox "That file has no orders in it.", vbInformation: Exit Sub

    Set hdr = CreateObject("Scripting.Dictionary")
    Dim h As Variant: h = ParseCsvLine(lines(1))
    For i = LBound(h) To UBound(h): hdr(UCase$(Trim$(h(i)))) = i: Next i
    If Not hdr.Exists("SERIAL") Or Not hdr.Exists("PART NAME") Then
        MsgBox "That doesn't look like a CHAT file from the Serracom app.", vbExclamation: Exit Sub
    End If

    Dim wsO As Worksheet, wsJ As Worksheet
    Set wsO = ThisWorkbook.Worksheets("Order form")
    Set wsJ = ThisWorkbook.Worksheets("Justification")

    Dim added As Long, skipped As String, noPart As String, v As Variant, r As Long, rj As Long
    Application.EnableEvents = False
    Application.ScreenUpdating = False
    On Error GoTo Done
    For i = 2 To lines.Count
        If Len(Trim$(lines(i))) > 0 Then
            v = ParseCsvLine(lines(i))
            Dim sn As String: sn = Col(v, hdr, "SERIAL")
            If sn = "" Then GoTo NextLine
            If SerialOnForm(wsO, sn) Then skipped = skipped & vbCrLf & "  " & sn & " (already on the form)": GoTo NextLine
            If Col(v, hdr, "PART NAME") = "" Then noPart = noPart & vbCrLf & "  " & sn & " (" & Col(v, hdr, "MODEL") & ")"

            ' ---- Order form ----
            r = NextOrderRow(wsO)
            wsO.Cells(r, "A").Value = "ORDER "
            wsO.Cells(r, "B").Value = Col(v, hdr, "PART NAME")
            If Not wsO.Cells(r, "D").HasFormula Then wsO.Cells(r, "D").Value = "YES"
            wsO.Cells(r, "E").Value = sn
            wsO.Cells(r, "G").Value = Col(v, hdr, "GC")
            ColorGC wsO.Cells(r, "G")
            wsO.Cells(r, "H").Value = Col(v, hdr, "PICKUP")
            wsO.Cells(r, "I").Value = Col(v, hdr, "PHONE")
            wsO.Cells(r, "J").Value = Col(v, hdr, "INC")
            wsO.Cells(r, "K").Value = Col(v, hdr, "FREQUENCY")
            wsO.Cells(r, "L").Value = Col(v, hdr, "FAIL REASON")
            wsO.Cells(r, "M").Value = Col(v, hdr, "SITE ID")
            wsO.Cells(r, "N").Value = Col(v, hdr, "SECTOR")

            ' ---- Justification ----
            rj = NextRow(wsJ, 3, "B")
            wsJ.Cells(rj, "A").Value = "New request"
            wsJ.Cells(rj, "B").Value = Col(v, hdr, "PART NAME")
            wsJ.Cells(rj, "C").Value = Col(v, hdr, "FAIL REASON")
            wsJ.Cells(rj, "D").Value = "Equipment"
            wsJ.Cells(rj, "E").Value = Col(v, hdr, "INC")
            wsJ.Cells(rj, "F").Value = Col(v, hdr, "TECHNOLOGIES")
            wsJ.Cells(rj, "G").Value = Col(v, hdr, "SECTOR")
            wsJ.Cells(rj, "H").Value = "Tower top"
            wsJ.Cells(rj, "I").Value = UCase$(Col(v, hdr, "ALARM NOTES"))
            added = added + 1
        End If
NextLine:
    Next i
Done:
    Application.EnableEvents = True
    Application.ScreenUpdating = True
    If Err.Number <> 0 Then MsgBox "Stopped early: " & Err.Description, vbExclamation

    Dim msg As String
    msg = added & " order" & IIf(added = 1, "", "s") & " added to the Order form and Justification."
    If skipped <> "" Then msg = msg & vbCrLf & vbCrLf & "Skipped:" & skipped
    If noPart <> "" Then msg = msg & vbCrLf & vbCrLf & "No CHAT part name, pick it by hand:" & noPart
    MsgBox msg, vbInformation, "Pull red tags"
End Sub

Private Function Col(v As Variant, hdr As Object, name As String) As String
    If Not hdr.Exists(name) Then Exit Function
    If hdr(name) > UBound(v) Then Exit Function
    Col = Trim$(CStr(v(hdr(name))))
End Function

Private Function SerialOnForm(ws As Worksheet, sn As String) As Boolean
    Dim last As Long, c As Range
    last = ws.Cells(ws.Rows.Count, "E").End(xlUp).Row
    If last < 4 Then Exit Function
    For Each c In ws.Range("E4:E" & last).Cells
        If Not c.HasFormula Then
            If UCase$(Trim$(CStr(c.Value))) = UCase$(sn) Then SerialOnForm = True: Exit Function
        End If
    Next c
End Function

' First Order form row whose Part Name is empty. Grows the table if it's full.
Private Function NextOrderRow(ws As Worksheet) As Long
    Dim lo As ListObject, r As Long, lastR As Long
    If ws.ListObjects.Count > 0 Then
        Set lo = ws.ListObjects(1)
        lastR = lo.Range.Row + lo.Range.Rows.Count - 1
        For r = 4 To lastR
            If Trim$(CStr(ws.Cells(r, "B").Value)) = "" Then NextOrderRow = r: Exit Function
        Next r
        lo.ListRows.Add
        NextOrderRow = lastR + 1
    Else
        NextOrderRow = NextRow(ws, 4, "B")
    End If
End Function

Private Function NextRow(ws As Worksheet, firstRow As Long, col As String) As Long
    Dim r As Long: r = firstRow
    Do While Trim$(CStr(ws.Cells(r, col).Value)) <> ""
        r = r + 1
    Loop
    NextRow = r
End Function

' Same look the Order form gives the GC column when you type in it.
Private Sub ColorGC(cell As Range)
    Dim s As String, p As Long
    s = CStr(cell.Value): p = InStr(s, " ")
    If p = 0 Then Exit Sub
    With cell.Characters(1, Len(s)).Font: .ColorIndex = xlAutomatic: .Bold = False: End With
    With cell.Characters(p + 1, Len(s) - p).Font: .Color = RGB(0, 128, 128): .Bold = True: .Size = 14: End With
End Sub

Private Function ReadLines(path As String) As Collection
    Dim fn As Integer, s As String, out As New Collection
    fn = FreeFile
    Open path For Binary Access Read As #fn
    s = Space$(LOF(fn))
    Get #fn, , s
    Close #fn
    If Left$(s, 3) = Chr$(239) & Chr$(187) & Chr$(191) Then s = Mid$(s, 4)
    s = Replace(s, vbCrLf, vbLf): s = Replace(s, vbCr, vbLf)
    Dim parts() As String, i As Long
    parts = Split(s, vbLf)
    For i = LBound(parts) To UBound(parts)
        If Len(parts(i)) > 0 Then out.Add parts(i)
    Next i
    Set ReadLines = out
End Function

Private Function ParseCsvLine(ByVal line As String) As Variant
    Dim out() As String, n As Long, i As Long, ch As String, cur As String, inQ As Boolean
    ReDim out(0 To 0)
    For i = 1 To Len(line)
        ch = Mid$(line, i, 1)
        If inQ Then
            If ch = """" Then
                If Mid$(line, i + 1, 1) = """" Then cur = cur & """": i = i + 1 Else inQ = False
            Else
                cur = cur & ch
            End If
        ElseIf ch = """" Then
            inQ = True
        ElseIf ch = "," Then
            out(n) = cur: cur = "": n = n + 1: ReDim Preserve out(0 To n)
        Else
            cur = cur & ch
        End If
    Next i
    out(n) = cur
    ParseCsvLine = out
End Function
