# ---- build stage: compile to a native executable with GraalVM ----
FROM ghcr.io/graalvm/native-image-community:21 AS build

# The base image ships without findutils, but the Gradle wrapper script shells out to xargs.
RUN microdnf install -y findutils && microdnf clean all

WORKDIR /workspace

# Wrapper + build scripts first so dependency resolution is cached independently of sources.
COPY gradlew gradlew.bat ./
COPY gradle gradle
COPY settings.gradle.kts build.gradle.kts ./
RUN chmod +x gradlew && ./gradlew --no-daemon dependencies --configuration runtimeClasspath

COPY src src
RUN ./gradlew --no-daemon nativeCompile

# ---- runtime stage ----
FROM debian:bookworm-slim

RUN useradd --system --create-home --shell /usr/sbin/nologin app
WORKDIR /app

COPY --from=build /workspace/build/native/nativeCompile/osmium ./osmium

USER app
EXPOSE 8080
ENTRYPOINT ["./osmium"]
