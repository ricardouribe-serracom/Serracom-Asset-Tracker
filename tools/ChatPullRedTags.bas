Attribute VB_Name = "ChatPullRedTags"
' Serracom CHAT Request Form helper.
' Reads the CSV from the app's "Export CHAT" button and fills the Order form and Justification tabs.
' Only typing cells are filled, into the existing rows, so the form keeps its formats and formulas.
' Formula columns C (Asset Returned Required) and F (Request date), and any formula in D, are never touched.
' A serial that's already on the Order form is skipped, so running it twice doesn't add lines twice.
' Consumables (no serial) get one line per unit used, with N/A as the serial.
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
            If sn = "" Then
                ' Consumable (jumper, fiber, SFP): no serial, one form line per unit used
                Dim qty As Long, have As Long, k As Long
                qty = Val(Col(v, hdr, "QTY")): If qty < 1 Then qty = 1
                If Col(v, hdr, "PART NAME") = "" Then noPart = noPart & vbCrLf & "  " & Col(v, hdr, "MODEL") & " at " & Col(v, hdr, "SITE ID"): GoTo NextLine
                have = LinesOnForm(wsO, Col(v, hdr, "PART NAME"), Col(v, hdr, "INC"), Col(v, hdr, "SITE ID"))
                If have >= qty Then skipped = skipped & vbCrLf & "  " & Col(v, hdr, "MODEL") & " at " & Col(v, hdr, "SITE ID") & " (already on the form)": GoTo NextLine
                For k = have + 1 To qty
                    r = NextOrderRow(wsO)
                    FillOrderLine wsO, r, v, hdr, "N/A"
                    rj = NextRow(wsJ, 3, "B")
                    If rj > 3 Then MatchRowAbove wsJ, rj, "A", "J"
                    FillJustification wsJ, rj, v, hdr
                    added = added + 1
                Next k
                GoTo NextLine
            End If
            If SerialOnForm(wsO, sn) Then skipped = skipped & vbCrLf & "  " & sn & " (already on the form)": GoTo NextLine
            If Col(v, hdr, "PART NAME") = "" Then noPart = noPart & vbCrLf & "  " & sn & " (" & Col(v, hdr, "MODEL") & ")"

            ' ---- Order form + Justification ----
            r = NextOrderRow(wsO)
            FillOrderLine wsO, r, v, hdr, sn
            rj = NextRow(wsJ, 3, "B")
            If rj > 3 Then MatchRowAbove wsJ, rj, "A", "J"
            FillJustification wsJ, rj, v, hdr
            added = added + 1
        End If
NextLine:
    Next i
Done:
    Application.EnableEvents = True
    Application.ScreenUpdating = True
    If Err.Number <> 0 Then MsgBox "Stopped early: " & Err.Description, vbExclamation

    Dim msg As String
    msg = added & " line" & IIf(added = 1, "", "s") & " added to the Order form and Justification."
    If skipped <> "" Then msg = msg & vbCrLf & vbCrLf & "Skipped:" & skipped
    If noPart <> "" Then msg = msg & vbCrLf & vbCrLf & "No CHAT part name, pick it by hand:" & noPart
    MsgBox msg, vbInformation, "Pull red tags"
End Sub

Private Sub FillOrderLine(ws As Worksheet, r As Long, v As Variant, hdr As Object, sn As String)
    ws.Cells(r, "A").Value = "ORDER "
    ws.Cells(r, "B").Value = Col(v, hdr, "PART NAME")
    ws.Calculate
    ' D follows column C (the form's formula): parts that must go back get YES, the rest N/A
    If Not ws.Cells(r, "D").HasFormula Then ws.Cells(r, "D").Value = IIf(UCase$(CStr(ws.Cells(r, "C").Value)) = "NO", "N/A", "YES")
    ws.Cells(r, "E").Value = sn
    ws.Cells(r, "G").Value = Col(v, hdr, "GC")
    ColorGC ws.Cells(r, "G")
    ws.Cells(r, "H").Value = Col(v, hdr, "PICKUP")
    ws.Cells(r, "I").Value = Col(v, hdr, "PHONE")
    ws.Cells(r, "J").Value = Col(v, hdr, "INC")
    ws.Cells(r, "K").Value = Col(v, hdr, "FREQUENCY")
    ws.Cells(r, "L").Value = Col(v, hdr, "FAIL REASON")
    ws.Cells(r, "M").Value = Col(v, hdr, "SITE ID")
    ws.Cells(r, "N").Value = Col(v, hdr, "SECTOR")
End Sub

Private Sub FillJustification(ws As Worksheet, r As Long, v As Variant, hdr As Object)
    ws.Cells(r, "A").Value = "New request"
    ws.Cells(r, "B").Value = Col(v, hdr, "PART NAME")
    ws.Cells(r, "C").Value = Col(v, hdr, "FAIL REASON")
    ws.Cells(r, "D").Value = "Equipment"
    ws.Cells(r, "E").Value = Col(v, hdr, "INC")
    ws.Cells(r, "F").Value = Col(v, hdr, "TECHNOLOGIES")
    ws.Cells(r, "G").Value = Col(v, hdr, "SECTOR")
    ws.Cells(r, "H").Value = "Tower top"
    ws.Cells(r, "I").Value = UCase$(Col(v, hdr, "ALARM NOTES"))
End Sub

' How many Order form lines already have this part for this ticket and site (so a re-run adds nothing twice).
Private Function LinesOnForm(ws As Worksheet, part As String, inc As String, site As String) As Long
    Dim last As Long, r As Long, n As Long
    last = ws.Cells(ws.Rows.Count, "B").End(xlUp).Row
    For r = 4 To last
        If Trim$(CStr(ws.Cells(r, "B").Value)) = part And UCase$(Trim$(CStr(ws.Cells(r, "J").Value))) = UCase$(inc) And UCase$(Trim$(CStr(ws.Cells(r, "M").Value))) = UCase$(site) Then n = n + 1
    Next r
    LinesOnForm = n
End Function

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

'' Gives a new Justification row the same borders, fonts and dropdowns as the row above it.
Private Sub MatchRowAbove(ws As Worksheet, r As Long, firstCol As String, lastCol As String)
    If Trim$(CStr(ws.Cells(r - 1, "B").Value)) = "" Then Exit Sub
    ws.Range(firstCol & (r - 1) & ":" & lastCol & (r - 1)).Copy
    ws.Range(firstCol & r & ":" & lastCol & r).PasteSpecial Paste:=xlPasteFormats
    ws.Range(firstCol & r & ":" & lastCol & r).PasteSpecial Paste:=xlPasteValidation
    Application.CutCopyMode = False
End Sub

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
