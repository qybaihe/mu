; ARM64 architecture entry for the NSIS installer.

!include "x64.nsh"

!define MU_TARGET_ARCH "arm64"
!define MU_RUNTIME_KEY "win32-arm64"
!define MU_EXTRACT_METHOD "zip"

!addincludedir "${PROJECT_DIR}\resources\windows"
!include "installer-common.nsh"

!macro customHeader
  !insertmacro MU_INSTALLER_CUSTOM_HEADER
!macroend

!macro preInit
  !insertmacro MU_INSTALLER_PREINIT
!macroend

!macro customFiles_arm64
  !insertmacro MU_LOG_EXTRACT_RESULT "zip"
!macroend

; Architecture guard. Inserted from MU_INSTALLER_PREINIT (preInit) so it runs before any
; registry mutation, replacing the old .onVerifyInstDir placement which fired after customInit
; had already healed/cleared/repaired an existing install's registry. (Sentry ELECTRON-3BX)
!macro MU_ASSERT_TARGET_ARCH
  Var /GLOBAL MuActualArch
  ${IfNot} ${IsNativeARM64}
    !insertmacro MU_DETECT_NATIVE_ARCH $MuActualArch
    !insertmacro MU_FAIL_UX \
      "${MU_E_ARCH_MISMATCH}" \
      "target=arm64 actual=$MuActualArch" \
      "${MU_MSG_ARCH_MISMATCH_ZH}" \
      "${MU_MSG_ARCH_MISMATCH_EN}" \
      "${MU_MSG_ARCH_MISMATCH_ACTION_ZH}" \
      "${MU_MSG_ARCH_MISMATCH_ACTION_EN}" \
      "target=arm64 actual=$MuActualArch" \
      "target=arm64 actual=$MuActualArch"
  ${EndIf}
!macroend
