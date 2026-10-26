"""Build a synthetic EXIF-only HEIC. Fixture tooling, never used by the API.

The CLI translates EXIF to irot. The public libheif C API lets this test keep
legacy EXIF orientation without adding a container transform. Needs Pillow.
"""
import ctypes as c
import ctypes.util
import sys
from pathlib import Path
from PIL import Image

class Error(c.Structure):
    _fields_ = [("code", c.c_int), ("subcode", c.c_int), ("message", c.c_char_p)]

lib = c.CDLL(ctypes.util.find_library("heif"))
ptr = c.c_void_p
lib.heif_context_alloc.restype = ptr
for name, args in [
    ("heif_image_create", [c.c_int, c.c_int, c.c_int, c.c_int, c.POINTER(ptr)]),
    ("heif_image_add_plane", [ptr, c.c_int, c.c_int, c.c_int, c.c_int]),
    ("heif_context_get_encoder_for_format", [ptr, c.c_int, c.POINTER(ptr)]),
    ("heif_encoder_set_lossy_quality", [ptr, c.c_int]),
    ("heif_encoder_set_parameter_string", [ptr, c.c_char_p, c.c_char_p]),
    ("heif_context_encode_image", [ptr, ptr, ptr, ptr, c.POINTER(ptr)]),
    ("heif_context_add_exif_metadata", [ptr, ptr, ptr, c.c_int]),
    ("heif_context_write_to_file", [ptr, c.c_char_p]),
]:
    fn = getattr(lib, name)
    fn.argtypes = args
    fn.restype = Error
lib.heif_image_get_plane.argtypes = [ptr, c.c_int, c.POINTER(c.c_int)]
lib.heif_image_get_plane.restype = ptr
for name in ["heif_image_handle_release", "heif_context_free", "heif_encoder_release", "heif_image_release"]:
    getattr(lib, name).argtypes = [ptr]

def check(error):
    if error.code:
        raise RuntimeError("Synthetic HEIC fixture operation failed")

ctx = lib.heif_context_alloc()
image, encoder, handle = ptr(), ptr(), ptr()
try:
    source = Image.open(sys.argv[1]).convert("RGB")
    w, h = source.size
    check(lib.heif_image_create(w, h, 1, 10, c.byref(image)))
    check(lib.heif_image_add_plane(image, 10, w, h, 8))
    stride = c.c_int()
    address = lib.heif_image_get_plane(image, 10, c.byref(stride))
    pixels = source.tobytes()
    for y in range(h):
        c.memmove(address + y * stride.value, pixels[y*w*3:(y+1)*w*3], w*3)
    check(lib.heif_context_get_encoder_for_format(ctx, 1, c.byref(encoder)))
    check(lib.heif_encoder_set_lossy_quality(encoder, 90))
    check(lib.heif_encoder_set_parameter_string(encoder, b"x265:pools", b"1"))
    check(lib.heif_encoder_set_parameter_string(encoder, b"x265:frame-threads", b"1"))
    check(lib.heif_context_encode_image(ctx, image, encoder, None, c.byref(handle)))
    exif = Path(sys.argv[2]).read_bytes()
    payload = c.create_string_buffer(exif)
    check(lib.heif_context_add_exif_metadata(ctx, handle, payload, len(exif)))
    check(lib.heif_context_write_to_file(ctx, sys.argv[3].encode()))
finally:
    if handle: lib.heif_image_handle_release(handle)
    if encoder: lib.heif_encoder_release(encoder)
    if image: lib.heif_image_release(image)
    lib.heif_context_free(ctx)
