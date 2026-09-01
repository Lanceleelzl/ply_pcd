# Local modifications

No LASzip upstream source file is modified.

The project-level `CMakeLists.txt` selects `LASZIP_BUILD_STATIC=ON` and links the platform-specific LASzip target into `registration_worker`. The project-owned adapter is implemented outside this directory in `cpp/src/las_reader.cpp`.
