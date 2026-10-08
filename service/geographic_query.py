"""Query-only conversion of original file coordinates to geographic coordinates."""
from math import isfinite
from typing import Literal

from pydantic import BaseModel, Field, model_validator
from pyproj import CRS, Transformer


class GeographicQuery(BaseModel):
    point: tuple[float, float, float]
    axes: tuple[int, int, int]
    reference: tuple[float, float, float]
    independent_origin: tuple[float, float, float]
    projected_origin: tuple[float, float, float]
    metres_per_unit: float = Field(gt=0)
    source_epsg: int = Field(gt=0)
    target_epsg: Literal[4326] = 4326

    @model_validator(mode="after")
    def validate_coordinates(self):
        if sorted(abs(axis) for axis in self.axes) != [1, 2, 3]:
            raise ValueError("东、北、上必须对应三条不同的轴")
        numbers = (*self.point, *self.reference, *self.independent_origin,
                   *self.projected_origin, self.metres_per_unit)
        if not all(isfinite(value) for value in numbers):
            raise ValueError("坐标与单位必须为有限数值")
        return self


class GeographicOrigin(BaseModel):
    source_epsg: int = Field(gt=0)
    longitude: float = Field(ge=-180, le=180)
    latitude: float = Field(ge=-80, le=84)


def project_origin(request: GeographicOrigin) -> dict:
    source = CRS.from_epsg(request.source_epsg)
    if not source.is_projected:
        raise ValueError("源 EPSG 必须为投影坐标系")
    east, north = Transformer.from_crs(4326, source, always_xy=True).transform(
        request.longitude, request.latitude, errcheck=True)
    if not all(isfinite(value) for value in (east, north)):
        raise ValueError("原点无法转换到源投影坐标系")
    factors = [axis.unit_conversion_factor for axis in source.axis_info[:2]]
    if len(factors) != 2 or not all(value and isfinite(value) for value in factors):
        raise ValueError("源投影坐标系单位无法转换")
    if source.axis_info[0].direction == "north":
        factors.reverse()
    return {"east": east, "north": north, "source_name": source.name, "metres_per_projected_unit": factors}


def query_coordinates(request: GeographicQuery) -> dict:
    source = CRS.from_epsg(request.source_epsg)
    if not source.is_projected or len(source.axis_info) < 2:
        raise ValueError("源 EPSG 必须为投影坐标系，不能使用经纬度 EPSG作为米制坐标")
    delta = [request.point[i] - request.reference[i] for i in range(3)]
    offsets = [delta[abs(axis) - 1] * (1 if axis > 0 else -1) * request.metres_per_unit
               for axis in request.axes]
    independent = [request.independent_origin[i] + offsets[i] for i in range(3)]
    factors = [source.axis_info[i].unit_conversion_factor for i in range(2)]
    if not all(value and isfinite(value) for value in factors):
        raise ValueError("源投影坐标系单位无法转换")
    # always_xy normalizes projected output to easting/northing, regardless of native axis order.
    if source.axis_info[0].direction == "north":
        factors.reverse()
    projected = [request.projected_origin[i] + offsets[i] / factors[i] for i in range(2)]
    transformer = Transformer.from_crs(source, request.target_epsg, always_xy=True)
    lon, lat = transformer.transform(*projected, errcheck=True)
    if not isfinite(lon) or not isfinite(lat) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
        raise ValueError("转换结果超出经纬度范围，请检查 EPSG、参考点与轴向")
    operation = transformer.get_last_used_operation()
    return {"independent": independent, "projected": [*projected, request.projected_origin[2] + offsets[2]],
            "longitude": lon, "latitude": lat, "source_name": source.name,
            "target_epsg": request.target_epsg, "accuracy": operation.accuracy,
            "approximate": any(item.has_ballpark_transformation for item in operation.operations),
            "height_note": "高度沿用原点高度基准，未执行高程基准转换"}
