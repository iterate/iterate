# Distributed under the OSI-approved BSD 3-Clause License.  See accompanying
# file LICENSE.rst or https://cmake.org/licensing for details.

cmake_minimum_required(VERSION ${CMAKE_VERSION}) # this file comes with cmake

# If CMAKE_DISABLE_SOURCE_CHANGES is set to true and the source directory is an
# existing directory in our source tree, calling file(MAKE_DIRECTORY) on it
# would cause a fatal error, even though it would be a no-op.
if(NOT EXISTS "/Users/jonastemplestein/esp/esp-idf/components/bootloader/subproject")
  file(MAKE_DIRECTORY "/Users/jonastemplestein/esp/esp-idf/components/bootloader/subproject")
endif()
file(MAKE_DIRECTORY
  "/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities/apps/.build/home-assistant-voice-preview-edition-aec-tap/bootloader"
  "/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities/apps/.build/home-assistant-voice-preview-edition-aec-tap/bootloader-prefix"
  "/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities/apps/.build/home-assistant-voice-preview-edition-aec-tap/bootloader-prefix/tmp"
  "/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities/apps/.build/home-assistant-voice-preview-edition-aec-tap/bootloader-prefix/src/bootloader-stamp"
  "/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities/apps/.build/home-assistant-voice-preview-edition-aec-tap/bootloader-prefix/src"
  "/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities/apps/.build/home-assistant-voice-preview-edition-aec-tap/bootloader-prefix/src/bootloader-stamp"
)

set(configSubDirs )
foreach(subDir IN LISTS configSubDirs)
    file(MAKE_DIRECTORY "/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities/apps/.build/home-assistant-voice-preview-edition-aec-tap/bootloader-prefix/src/bootloader-stamp/${subDir}")
endforeach()
if(cfgdir)
  file(MAKE_DIRECTORY "/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities/apps/.build/home-assistant-voice-preview-edition-aec-tap/bootloader-prefix/src/bootloader-stamp${cfgdir}") # cfgdir has leading slash
endif()
