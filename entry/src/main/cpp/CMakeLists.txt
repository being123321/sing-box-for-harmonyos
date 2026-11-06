cmake_minimum_required(VERSION 3.5.0)
project(harmony_network_assistant)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(NATIVE_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR})
set(HARMONY_CORE_OUTPUT_PATH
    ${NATIVE_ROOT_PATH}/../../../../core/go/out)
set(HARMONY_CORE_LIBRARY
    ${HARMONY_CORE_OUTPUT_PATH}/libharmonycore.so)

if(NOT EXISTS ${HARMONY_CORE_LIBRARY})
    message(FATAL_ERROR
        "Missing ${HARMONY_CORE_LIBRARY}. Build the OHOS arm64 Go core before assembling the HAP.")
endif()

add_library(entry SHARED napi_init.cpp)
set_target_properties(entry PROPERTIES SKIP_BUILD_RPATH TRUE)
# Linking by -lharmonycore alone does not tell Ninja when the Go artifact
# changed. Relink so POST_BUILD stages the new core instead of a cached one.
set_property(TARGET entry APPEND PROPERTY LINK_DEPENDS ${HARMONY_CORE_LIBRARY})

target_include_directories(entry PRIVATE ${HARMONY_CORE_OUTPUT_PATH})

# Link by library name (rather than by an absolute file path) so DT_NEEDED is
# libharmonycore.so and the HarmonyOS loader can resolve it beside libentry.so.
target_link_directories(entry PRIVATE ${HARMONY_CORE_OUTPUT_PATH})
target_link_libraries(entry PUBLIC libace_napi.z.so harmonycore)

# Hvigor collects native libraries from the CMake output directory. Keep the
# canonical Go artifact under core/go/out and stage a build copy next to the
# N-API library instead of committing a second 37 MB binary under entry/libs.
add_custom_command(TARGET entry POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        ${HARMONY_CORE_LIBRARY}
        $<TARGET_FILE_DIR:entry>/libharmonycore.so
    VERBATIM)
