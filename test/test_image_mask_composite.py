from io import BytesIO

from PIL import Image

from services.protocol.openai_v1_image_edit import _composite_mask


def _png(image: Image.Image) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_annotation_mask_transparent_area_is_forwarded_as_editable_alpha() -> None:
    source = Image.new("RGB", (2, 1), (10, 20, 30))
    mask = Image.new("RGBA", (2, 1), (255, 255, 255, 255))
    mask.putpixel((1, 0), (255, 255, 255, 0))

    result = _composite_mask(
        [(_png(source), "source.png", "image/png")],
        [(_png(mask), "edit-mask.png", "image/png")],
    )

    assert len(result) == 1
    assert result[0][2] == "image/png"
    composited = Image.open(BytesIO(result[0][0])).convert("RGBA")
    assert composited.getpixel((0, 0)) == (10, 20, 30, 255)
    assert composited.getpixel((1, 0)) == (10, 20, 30, 0)
