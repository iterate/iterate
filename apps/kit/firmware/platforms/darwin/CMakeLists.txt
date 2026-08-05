find_package(Threads REQUIRED)

if(EXISTS "/opt/homebrew/opt/openssl@3")
  set(
    OPENSSL_ROOT_DIR "/opt/homebrew/opt/openssl@3"
    CACHE PATH "Homebrew OpenSSL 3 prefix")
endif()
find_package(OpenSSL 3 REQUIRED)
find_library(ITERATE_KIT_AUDIO_TOOLBOX_FRAMEWORK AudioToolbox REQUIRED)
find_library(ITERATE_KIT_CORE_FOUNDATION_FRAMEWORK CoreFoundation REQUIRED)

add_library(iterate-kit-darwin STATIC
  darwin_audio_codec.c
  darwin_audio_input.c
  darwin_audio_output.c
  posix_itx_transport.c
  tls_stream.c
  websocket_client.c)

target_include_directories(iterate-kit-darwin PUBLIC include)
target_compile_features(iterate-kit-darwin PUBLIC c_std_99)
target_compile_options(iterate-kit-darwin PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
target_link_libraries(iterate-kit-darwin PUBLIC
  iterate-kit-audio
  iterate-kit-core
  ${ITERATE_KIT_AUDIO_TOOLBOX_FRAMEWORK}
  ${ITERATE_KIT_CORE_FOUNDATION_FRAMEWORK}
  OpenSSL::SSL
  OpenSSL::Crypto
  Threads::Threads)
