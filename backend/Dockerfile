# ---- build stage: compile to a native executable with GraalVM ----
# Liberica NIK rather than ghcr.io/graalvm/*: the community GraalVM images stop at JDK 22, and
# their JDK 21 line is frozen at 21.0.2, which is too old for the native-build-tools metadata schema.
FROM bellsoft/liberica-native-image-kit-container:jdk-25-nik-25.0.4-glibc AS build

WORKDIR /workspace

# Wrapper + build scripts first so dependency resolution is cached independently of sources.
COPY gradlew gradlew.bat ./
COPY gradle gradle
COPY settings.gradle.kts build.gradle.kts ./
RUN chmod +x gradlew && ./gradlew --no-daemon dependencies --configuration runtimeClasspath

COPY src src
RUN ./gradlew --no-daemon nativeCompile

# ---- runtime stage ----
# Alpaquita on both sides: the binary links against the build image's glibc 2.43, which is newer
# than Debian bookworm ships, so the runtime base has to match rather than be "some slim glibc".
FROM bellsoft/alpaquita-linux-base:stream-glibc

RUN addgroup -S app && adduser -S -G app app
WORKDIR /app

COPY --from=build /workspace/build/native/nativeCompile/osmium ./osmium

USER app
EXPOSE 8080
ENTRYPOINT ["./osmium"]
