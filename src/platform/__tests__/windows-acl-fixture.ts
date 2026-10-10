// Use a duplicate impersonation token so an elevated test runner also exercises
// the absence of SeSecurityPrivilege, without changing its process token.
export const withoutAuditPrivilege = (script: string): string => `
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class AclTestPrivilegeScope : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct Privileges { public uint Count; public Luid Id; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr source, uint access, IntPtr attributes, int level, int type, out IntPtr handle);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid id);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr handle, bool disableAll, ref Privileges privileges, uint size, IntPtr previous, IntPtr returned);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetThreadToken(IntPtr thread, IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool RevertToSelf();
  IntPtr duplicate;
  public AclTestPrivilegeScope() {
    IntPtr source;
    if (!OpenProcessToken(GetCurrentProcess(), 0x000a, out source)) throw new Win32Exception();
    try {
      if (!DuplicateTokenEx(source, 0x002e, IntPtr.Zero, 2, 2, out duplicate)) throw new Win32Exception();
      Luid id;
      if (!LookupPrivilegeValue(null, "SeSecurityPrivilege", out id)) throw new Win32Exception();
      Privileges privileges = new Privileges { Count = 1, Id = id, Attributes = 4 };
      if (!AdjustTokenPrivileges(duplicate, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
      int error = Marshal.GetLastWin32Error();
      if (error != 0 && error != 1300) throw new Win32Exception(error);
      if (!SetThreadToken(IntPtr.Zero, duplicate)) throw new Win32Exception();
    } catch { if (duplicate != IntPtr.Zero) CloseHandle(duplicate); throw; }
    finally { CloseHandle(source); }
  }
  public void Dispose() {
    if (!RevertToSelf()) throw new Win32Exception();
    CloseHandle(duplicate);
    duplicate = IntPtr.Zero;
  }
}
'@
$privilegeScope = New-Object AclTestPrivilegeScope
try {
${script}
} finally { $privilegeScope.Dispose() }
`

export const privateAclAssertions = `
  $first = (Get-Item -LiteralPath $env:ACL_TEST_ROOT).GetAccessControl()
  if (-not $first.AreAccessRulesProtected) { throw 'DACL inheritance was not disabled' }
  if ($before.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $first.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Owner changed' }
  if ($before.GetGroup([Security.Principal.SecurityIdentifier]).Value -ne $first.GetGroup([Security.Principal.SecurityIdentifier]).Value) { throw 'Group changed' }
  $trusted = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
  $rules = @($first.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  foreach ($rule in $rules) {
    if ($trusted -notcontains $rule.IdentityReference.Value -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { throw 'Unexpected private DACL rule' }
  }
  if ($rules.Count -ne 3) { throw 'Missing trusted DACL rules' }
`

// A protected DACL exposes Set-Acl's audit-section fallback bug reliably.
export const unsafeAclFixture = `
  $ErrorActionPreference = 'Stop'
  $item = Get-Item -LiteralPath $env:ACL_TEST_ROOT
  $fixtureAcl = $item.GetAccessControl()
  $fixtureAcl.SetAccessRuleProtection($true, $true)
  $everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
  $inherit = if ($item.PSIsContainer) { 'ContainerInherit, ObjectInherit' } else { 'None' }
  $fixtureAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone, 'Modify', $inherit, 'None', 'Allow')))
  if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($item.FullName, $fixtureAcl) }
  else { [IO.File]::SetAccessControl($item.FullName, $fixtureAcl) }
  $before = $item.GetAccessControl()
`
