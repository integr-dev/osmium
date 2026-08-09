# ---- build stage ----
FROM eclipse-temurin:25-jdk AS build

WORKDIR /workspace

# Wrapper + build scripts first so dependency resolution is cached independently of sources.
COPY gradlew gradlew.bat ./
COPY gradle gradle
COPY settings.gradle.kts build.gradle.kts ./
RUN chmod +x gradlew && ./gradlew --no-daemon dependencies --configuration runtimeClasspath

COPY src src
RUN ./gradlew --no-daemon bootJar

# ---- runtime stage ----
FROM eclipse-temurin:25-jre

RUN useradd --system --create-home --shell /usr/sbin/nologin app
WORKDIR /app

COPY --from=build /workspace/build/libs/*.jar ./app.jar

USER app
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
