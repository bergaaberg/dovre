#Requires -Version 7
<#
  Dovre's Teams helper (src/teams/helper.ts starts it): Microsoft Graph through Graph PowerShell's
  own sign-in, which the tenant has consented for. One request per line on stdin, one answer per
  line on stdout, as JSON.

  Graph PowerShell's token carries every scope the tenant consented for it (directory, mail, sites
  and more), so the guard is here: reads only from the paths below (chats; the inbox and followed
  team channels, read-only), and exactly two writes, each built here from checked
  parts (a chat message as plain text; a reaction from a fixed set). Mail and channel
  posts are held in memory by Dovre only (src/teams/outlook.ts, src/teams/channels.ts).
  src/teams/helper.ts keeps the same lists, and test/teams.test.ts checks the two match.

  Messages pass through; this script writes nothing anywhere. It also wraps and unwraps the key
  Dovre's Teams store is encrypted with (Windows DPAPI, this user only).
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# No Continuous Access Evaluation: behind a TLS-inspecting proxy, Graph may see another address than the sign-in did,
# answers with a claims challenge, and the SDK waits on a browser sign-in for every request.
$env:AZURE_IDENTITY_DISABLE_CP1 = 'true'

$Scopes = @('User.Read', 'Chat.ReadWrite')
$Allowed = @(
  '^/v1\.0/me\?\$select=id,displayName$'
  '^/v1\.0/me/chats\?\$expand=members,lastMessagePreview&\$top=\d{1,2}&\$orderby=lastMessagePreview/createdDateTime%20desc$'
  '^/v1\.0/me/chats\?\$expand=members,lastMessagePreview&\$top=\d{1,2}&\$orderby=lastMessagePreview/createdDateTime%20desc&\$skiptoken=[A-Za-z0-9%._~-]{1,4000}$'
  '^/v1\.0/chats/[A-Za-z0-9%._-]{1,200}/messages\?\$top=\d{1,2}$'
  '^/v1\.0/chats/[A-Za-z0-9%._-]{1,200}/messages\?\$top=\d{1,2}&\$skiptoken=[A-Za-z0-9%._~-]{1,4000}$'
  '^/v1\.0/chats/[A-Za-z0-9%._-]{1,200}/messages/\d{1,20}$'
  '^/v1\.0/me/mailFolders/inbox\?\$select=unreadItemCount,totalItemCount$'
  '^/v1\.0/me/mailFolders/inbox/messages\?\$select=id,subject,from,receivedDateTime,isRead,importance,flag,webLink,bodyPreview,inferenceClassification&\$orderby=receivedDateTime%20desc&\$top=\d{1,2}$'
  '^/v1\.0/me/joinedTeams$'
  '^/v1\.0/teams/[0-9a-f-]{36}/channels$'
  '^/v1\.0/teams/[0-9a-f-]{36}/channels/[A-Za-z0-9%._-]{1,200}/messages\?\$top=\d{1,2}&\$expand=replies$'
)
$ChatId = '^[A-Za-z0-9:@._-]{1,200}$'
$MessageId = '^\d{1,20}$'
# Teams' own six, as Graph names them in chats.
$Reactions = @('👍', '❤️', '😆', '😮', '😢', '😡')

function Reply($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
}

function Short([string]$s) {
  if (-not $s) { return 'failed' }
  $one = ($s -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
  if ($one.Length -gt 300) { return $one.Substring(0, 300) }
  return $one
}

function Chat([string]$id) {
  if ($id -cnotmatch $ChatId) { throw "not a chat id" }
  return [uri]::EscapeDataString($id)
}

try {
  Import-Module Microsoft.Graph.Authentication
} catch {
  Reply @{ id = 0; ok = $false; error = 'Graph PowerShell is missing: Install-Module Microsoft.Graph.Authentication -Scope CurrentUser' }
  exit 3
}
Reply @{ id = 0; ok = $true; ready = $true }

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $id = [int]$req.id
  try {
    switch -CaseSensitive ([string]$req.op) {
      'connect' {
        Connect-MgGraph -Scopes $Scopes -NoWelcome -ContextScope CurrentUser | Out-Null
        $ctx = Get-MgContext
        Reply @{ id = $id; ok = $true; account = [string]$ctx.Account }
      }
      'disconnect' {
        try { Disconnect-MgGraph | Out-Null } catch {}
        Reply @{ id = $id; ok = $true }
      }
      'get' {
        $path = [string]$req.path
        if (-not ($Allowed | Where-Object { $path -cmatch $_ })) { throw "not an allowed path" }
        if (-not (Get-MgContext)) { throw "not signed in" }
        $body = Invoke-MgGraphRequest -Method GET -Uri ("https://graph.microsoft.com" + $path) -OutputType Json
        # Base64: ConvertTo-Json leaves some control characters in message text unescaped.
        Reply @{ id = $id; ok = $true; body64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$body)) }
      }
      'send' {
        # A chat message, plain text only, built here: no HTML, no attachments, no mentions.
        $chat = Chat ([string]$req.chatId)
        $text = [string]$req.text
        if (-not $text.Trim() -or $text.Length -gt 4000) { throw "a message is 1 to 4000 characters" }
        if (-not (Get-MgContext)) { throw "not signed in" }
        $payload = @{ body = @{ contentType = 'text'; content = $text } } | ConvertTo-Json -Compress -Depth 3
        $r = Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/chats/$chat/messages" -Body $payload -ContentType 'application/json' -OutputType PSObject
        Reply @{ id = $id; ok = $true; messageId = [string]$r.id }
      }
      'react' {
        # Set or take back one of Teams' six reactions on one message.
        $chat = Chat ([string]$req.chatId)
        $msg = [string]$req.messageId
        if ($msg -cnotmatch $MessageId) { throw "not a message id" }
        $reaction = [string]$req.reaction
        if ($Reactions -cnotcontains $reaction) { throw "not one of Teams' reactions" }
        if (-not (Get-MgContext)) { throw "not signed in" }
        $verb = if ($req.on -eq $true) { 'setReaction' } else { 'unsetReaction' }
        $payload = @{ reactionType = $reaction } | ConvertTo-Json -Compress
        Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/chats/$chat/messages/$msg/$verb" -Body $payload -ContentType 'application/json' | Out-Null
        Reply @{ id = $id; ok = $true }
      }
      'wrap' {
        $plain = [Convert]::FromBase64String([string]$req.data)
        if ($plain.Length -ne 32) { throw "a key is 32 bytes" }
        $sealed = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, 'CurrentUser')
        Reply @{ id = $id; ok = $true; data = [Convert]::ToBase64String($sealed) }
      }
      'unwrap' {
        $plain = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([string]$req.data), $null, 'CurrentUser')
        Reply @{ id = $id; ok = $true; data = [Convert]::ToBase64String($plain) }
      }
      default { throw "unknown op" }
    }
  } catch {
    Reply @{ id = $id; ok = $false; error = (Short $_.Exception.Message) }
  }
}
