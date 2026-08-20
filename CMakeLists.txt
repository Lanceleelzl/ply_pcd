cmake_minimum_required(VERSION 3.25)

project(ply_pcd_registration VERSION 0.1.0 LANGUAGES CXX)

if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

option(REGISTRATION_BUILD_TESTS "Build registration tests" ON)

set(CCCORELIB_USE_QT_CONCURRENT OFF CACHE BOOL "" FORCE)
set(CCCORELIB_USE_TBB OFF CACHE BOOL "" FORCE)
set(CCCORELIB_USE_CGAL OFF CACHE BOOL "" FORCE)
set(CCCORELIB_SHARED OFF CACHE BOOL "" FORCE)
add_subdirectory(libs/cloudcompare_core EXCLUDE_FROM_ALL)

add_library(registration_io STATIC
    cpp/src/icp_registration.cpp
    cpp/src/matrix.cpp
    cpp/src/pcd_reader.cpp
    cpp/src/ply_reader.cpp
    cpp/src/point_cloud.cpp
)

target_include_directories(registration_io PUBLIC cpp/include)
target_compile_features(registration_io PUBLIC cxx_std_17)

if(MSVC)
    target_compile_options(registration_io PRIVATE /W4 /permissive- /utf-8)
else()
    target_compile_options(registration_io PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(registration_worker cpp/src/main.cpp)
target_link_libraries(registration_io PUBLIC CCCoreLib::CCCoreLib)
target_link_libraries(registration_worker PRIVATE registration_io)

if(REGISTRATION_BUILD_TESTS)
    enable_testing()
    add_executable(registration_tests cpp/tests/registration_tests.cpp)
    target_link_libraries(registration_tests PRIVATE registration_io)
    target_compile_definitions(registration_tests PRIVATE
        REGISTRATION_SOURCE_DIR="${CMAKE_SOURCE_DIR}"
    )
    add_test(NAME registration_tests COMMAND registration_tests)
endif()

install(TARGETS registration_worker RUNTIME DESTINATION bin)
