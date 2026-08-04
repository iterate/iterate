cmake_minimum_required(VERSION 3.20)

project(iterate_kit_firmware LANGUAGES C)

enable_testing()

add_subdirectory(components/core)
add_subdirectory(components/audio)
add_subdirectory(tests)
