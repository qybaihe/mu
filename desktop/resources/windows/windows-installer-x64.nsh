; x64 architecture entry for the NSIS installer.

!include "x64.nsh"

!define MU_TARGET_ARCH "x64"
!define MU_RUNTIME_KEY "win32-x64"
!define MU_EXTRACT_METHOD "7z"

!addincludedir "${PROJECT_DIR}\resources\windows"
!include "installer-common.nsh"

!macro customHeader
  !insertmacro MU_INSTALLER_CUSTOM_HEADER
!macroend

!macro preInit
  !insertmacro MU_INSTALLER_PREINIT
!macroend

!macro customFiles_x64
  !insertmacro MU_LOG_EXTRACT_RESULT "7z"
!macroend

; Architecture guard. Inserted from MU_INSTALLER_PREINIT (preInit) so it runs before any
; registry mutation, replacing the old .onVerifyInstDir placement which fired after customInit
; had already healed/cleared/repaired an existing install's registry. (Sentry ELECTRON-3BX)
; Rejection policy is unchanged: an x64 build refuses both x86 and ARM64 machines.
!macro MU_ASSERT_TARGET_ARCH
  Var /GLOBAL MuActualArch
  ${If} ${IsNativeARM64}
    !insertmacro MU_DETECT_NATIVE_ARCH $MuActualArch
    !insertmacro MU_FAIL_UX \
      "${MU_E_ARCH_MISMATCH}" \
      "target=x64 actual=$MuActualArch" \
      "${MU_MSG_ARCH_MISMATCH_ZH}" \
      "${MU_MSG_ARCH_MISMATCH_EN}" \
      "${MU_MSG_ARCH_MISMATCH_ACTION_ZH}" \
      "${MU_MSG_ARCH_MISMATCH_ACTION_EN}" \
      "target=x64 actual=$MuActualArch" \
      "target=x64 actual=$MuActualArch"
  ${ElseIfNot} ${RunningX64}
    !insertmacro MU_DETECT_NATIVE_ARCH $MuActualArch
    !insertmacro MU_FAIL_UX \
      "${MU_E_ARCH_MISMATCH}" \
      "target=x64 actual=$MuActualArch" \
      "${MU_MSG_ARCH_MISMATCH_ZH}" \
      "${MU_MSG_ARCH_MISMATCH_EN}" \
      "${MU_MSG_ARCH_MISMATCH_ACTION_ZH}" \
      "${MU_MSG_ARCH_MISMATCH_ACTION_EN}" \
      "target=x64 actual=$MuActualArch" \
      "target=x64 actual=$MuActualArch"
  ${EndIf}
!macroend
