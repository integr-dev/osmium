use json::{JsonValue, object};

#[derive(Clone, Copy)]
pub struct Vec3(pub f64, pub f64, pub f64);

impl From<Vec3> for JsonValue {
    fn from(value: Vec3) -> Self {
        object! {
            x: value.0,
            y: value.1,
            z: value.2,
        }
    }
}
