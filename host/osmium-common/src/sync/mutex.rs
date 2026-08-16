use std::sync::{Mutex, MutexGuard};

pub trait MutexExt<T> {
    fn lock_ignore(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_ignore(&self) -> MutexGuard<'_, T> {
        match self.lock() {
            Ok(v) => v,
            Err(e) => e.into_inner(),
        }
    }
}
