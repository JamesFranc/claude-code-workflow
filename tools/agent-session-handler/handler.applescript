-- Opens agent-session:// links from the board. Host `iterm`: focus the iTerm2 session whose unique id
-- matches; if it is gone, open a new iTerm2 tab in the launch dir and resume the Claude session.
on open location theURL
	try
		set refusalReason to my checkAgentURL(theURL)
		if refusalReason is not "" then
			display dialog "Agent Session can't open this link (" & refusalReason & "):" & return & theURL buttons {"OK"} default button 1
			return
		end if
		set urlInfo to my parseAgentURL(theURL)
		my openItermSession(itermId of urlInfo, claudeId of urlInfo, launchDir of urlInfo)
	on error errMsg number errNum
		display dialog "Agent Session failed (" & errNum & "):" & return & errMsg & return & return & theURL buttons {"OK"} default button 1
	end try
end open location

-- "" when the link may be acted on, otherwise the reason it is refused. Runs on the decoded values before
-- anything is typed or looked up: a decoded value can carry control characters that a terminal acts on.
on checkAgentURL(theURL)
	set urlInfo to my parseAgentURL(theURL)
	if hostName of urlInfo is not "iterm" then return "unknown host"
	return do shell script "/usr/bin/python3 -I " & quoted form of my helperPath("validate-link.py") & " " & quoted form of itermId of urlInfo & " " & quoted form of claudeId of urlInfo & " " & quoted form of launchDir of urlInfo
end checkAgentURL

-- AGENT_SESSION_HANDLER_DIR overrides the applet's own Resources folder, for tests that load the script outside the app.
on helperPath(helperName)
	set overrideDir to system attribute "AGENT_SESSION_HANDLER_DIR"
	if overrideDir is not "" then return overrideDir & "/" & helperName
	return POSIX path of (path to resource helperName)
end helperPath

on openItermSession(wantedItermId, wantedClaudeId, wantedDir)
	set foundSession to my findItermSession("id", wantedItermId)
	if foundSession is not missing value then
		my focusItermSession(foundSession)
		return
	end if
	set lookupResult to my liveSessionLookup(wantedClaudeId)
	set liveTty to my classifyLiveLookup(lookupResult)
	if liveTty is "unknown" then
		if not my confirmResumeAfterFailedLookup(lookupResult) then return
	else if liveTty is not "none" then
		if liveTty is not "no-tty" then
			set foundSession to my findItermSession("tty", "/dev/" & liveTty)
		end if
		if liveTty is "no-tty" or foundSession is missing value then
			display dialog "That Claude session is already running in another terminal, so it was not resumed." buttons {"OK"} default button 1
		else
			my focusItermSession(foundSession)
		end if
		return
	end if
	set resumeRefusal to my resumeDirRefusal(wantedClaudeId, wantedDir)
	if resumeRefusal is not "" then
		display dialog "That Claude session was not resumed: " & resumeRefusal buttons {"OK"} default button 1
		return
	end if
	tell application "iTerm2"
		activate
		if (count of windows) is 0 then
			set targetWin to (create window with default profile)
		else
			set targetWin to current window
			tell targetWin to create tab with default profile
		end if
		tell current session of targetWin
			write text my buildResumeCommand(my loadResumeTemplate(), wantedClaudeId, wantedDir)
		end tell
	end tell
end openItermSession

-- The first line of ~/.config/agent-session/resume-command, or "" when the file is missing or unreadable.
on loadResumeTemplate()
	try
		set templatePath to (POSIX path of (path to home folder)) & ".config/agent-session/resume-command"
		return do shell script "/usr/bin/head -n 1 " & quoted form of templatePath & " 2>/dev/null | /usr/bin/tr -d '\\r'"
	on error
		return ""
	end try
end loadResumeTemplate

-- Substitutes {cwd} and {claude} in the template with shell-quoted values; a blank template means the default.
on buildResumeCommand(theTemplate, theClaudeId, theDir)
	set effectiveTemplate to theTemplate
	if (do shell script "printf %s " & quoted form of theTemplate & " | /usr/bin/tr -d '[:space:]'") is "" then
		set effectiveTemplate to "cd {cwd} && claude --resume {claude}"
	end if
	set quotedDir to quoted form of theDir
	set quotedClaude to quoted form of theClaudeId
	set dirSegments to my splitAll(effectiveTemplate, "{cwd}")
	set rebuiltSegments to {}
	repeat with segmentPos from 1 to count of dirSegments
		set claudeSegments to my splitAll(item segmentPos of dirSegments, "{claude}")
		set end of rebuiltSegments to my joinAll(claudeSegments, quotedClaude)
	end repeat
	return my joinAll(rebuiltSegments, quotedDir)
end buildResumeCommand

on splitAll(theText, theDelim)
	set savedDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to theDelim
	set textParts to text items of theText
	set AppleScript's text item delimiters to savedDelims
	return textParts
end splitAll

on joinAll(theParts, theGlue)
	set savedDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to theGlue
	set joinedText to theParts as text
	set AppleScript's text item delimiters to savedDelims
	return joinedText
end joinAll

-- "pid<tab>tty" for a live Claude Code process running the session, "" when the scan completed and found none,
-- or "!" followed by the reason when the lookup could not run or could not complete.
on liveSessionLookup(theClaudeId)
	try
		return do shell script "/usr/bin/python3 -I " & quoted form of my helperPath("find-live-session.py") & " " & quoted form of theClaudeId
	on error errMsg
		return "!" & errMsg
	end try
end liveSessionLookup

-- "none" only for the helper's explicit empty result, "no-tty" when a process is live without a terminal,
-- "unknown" for a failed lookup or output that is not recognized, else the tty name.
on classifyLiveLookup(lookupResult)
	if lookupResult is "" then return "none"
	if lookupResult starts with "!" then return "unknown"
	set savedDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to tab
	set lookupFields to text items of lookupResult
	set AppleScript's text item delimiters to savedDelims
	if (count of lookupFields) is not 2 then return "unknown"
	try
		set livePid to (item 1 of lookupFields) as integer
	on error
		return "unknown"
	end try
	set ttyName to item 2 of lookupFields
	if ttyName is "" or ttyName is "??" then return "no-tty"
	return ttyName
end classifyLiveLookup

-- "" when the session's transcript is filed under the directory's project folder name, else the reason it may not be resumed there.
on resumeDirRefusal(theClaudeId, theDir)
	try
		return do shell script "/usr/bin/python3 -I " & quoted form of my helperPath("check-resume-dir.py") & " " & quoted form of theClaudeId & " " & quoted form of theDir
	on error errMsg
		return "the directory check failed: " & errMsg
	end try
end resumeDirRefusal

-- True when the user chose to resume although the running-session check failed.
on confirmResumeAfterFailedLookup(lookupResult)
	set failureReason to "the lookup output was not recognized"
	if lookupResult starts with "!" then set failureReason to text 2 thru -1 of lookupResult
	try
		set userChoice to button returned of (display dialog "Couldn't check whether this session is already running: " & failureReason buttons {"Cancel", "Resume anyway"} default button "Cancel" cancel button "Cancel")
	on error number -128
		return false
	end try
	return userChoice is "Resume anyway"
end confirmResumeAfterFailedLookup

-- Positions are looked up by window id and index, never held as references across a select: selecting
-- reorders iTerm2's windows, which invalidates references taken earlier.
on findItermSession(matchBy, wantedValue)
	tell application "iTerm2"
		set windowIds to id of every window
		repeat with windowPos from 1 to count of windowIds
			set currentWindowId to item windowPos of windowIds
			set tabCount to count of tabs of window id currentWindowId
			repeat with tabIndex from 1 to tabCount
				set sessionCount to count of sessions of tab tabIndex of window id currentWindowId
				repeat with sessionIndex from 1 to sessionCount
					set candidateSession to session sessionIndex of tab tabIndex of window id currentWindowId
					if matchBy is "tty" then
						set candidateValue to tty of candidateSession
					else
						set candidateValue to unique id of candidateSession
					end if
					if candidateValue is wantedValue then
						return {winId:currentWindowId, tabIdx:tabIndex, sessIdx:sessionIndex}
					end if
				end repeat
			end repeat
		end repeat
	end tell
	return missing value
end findItermSession

on focusItermSession(sessionPos)
	tell application "iTerm2"
		set targetWindow to window id (winId of sessionPos)
		tell targetWindow
			select session (sessIdx of sessionPos) of tab (tabIdx of sessionPos)
			select tab (tabIdx of sessionPos)
		end tell
		select targetWindow
		activate
	end tell
end focusItermSession

on parseAgentURL(theURL)
	set schemeSplit to my splitOnce(theURL, "://")
	set pathSplit to my splitOnce(item 2 of schemeSplit, "?")
	set queryText to item 2 of pathSplit
	set hostSplit to my splitOnce(item 1 of pathSplit, "/")
	return {hostName:item 1 of hostSplit, itermId:item 2 of hostSplit, claudeId:my queryParam(queryText, "claude"), launchDir:my queryParam(queryText, "cwd")}
end parseAgentURL

on splitOnce(theText, theDelim)
	set savedDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to theDelim
	set textParts to text items of theText
	set firstPart to item 1 of textParts
	if (count of textParts) < 2 then
		set AppleScript's text item delimiters to savedDelims
		return {theText, ""}
	end if
	set remainderText to (items 2 thru -1 of textParts) as text
	set AppleScript's text item delimiters to savedDelims
	return {firstPart, remainderText}
end splitOnce

on queryParam(queryText, paramName)
	set savedDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to "&"
	set pairList to text items of queryText
	set AppleScript's text item delimiters to savedDelims
	repeat with pairText in pairList
		set kvSplit to my splitOnce(pairText as text, "=")
		if item 1 of kvSplit is paramName then return my urlDecode(item 2 of kvSplit)
	end repeat
	return ""
end queryParam

on urlDecode(theText)
	return do shell script "/usr/bin/python3 -I -c 'import sys,urllib.parse;print(urllib.parse.unquote_plus(sys.argv[1]),end=\"\")' " & quoted form of theText
end urlDecode
