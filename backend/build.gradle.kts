plugins {
    kotlin("jvm") version "2.3.21"
    kotlin("plugin.spring") version "2.3.21"
    id("org.springframework.boot") version "4.1.0"
    id("io.spring.dependency-management") version "1.1.7"
    id("org.hibernate.orm") version "7.4.1.Final"
    kotlin("plugin.jpa") version "2.3.21"
}

group = "net.integr"
version = "0.5.0"
description = "backend"

// Emits META-INF/build-info.properties, which is what lets the OpenAPI document report the real
// version rather than a hand-typed one. The hand-typed one had drifted two releases behind.
springBoot {
    buildInfo()
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-websocket")
    implementation("org.jetbrains.kotlin:kotlin-reflect")
    implementation("tools.jackson.module:jackson-module-kotlin")
    implementation("org.springframework.security:spring-security-oauth2-jose")
    implementation("org.springframework.security:spring-security-oauth2-resource-server")
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:3.1.0")
    // The schema is migrated, not inferred. Three artifacts, and all three are load-bearing:
    // `spring-boot-flyway` carries the auto-configuration, which Boot 4 split out of the core jar -
    // without it Flyway sits on the classpath and never runs; and `flyway-database-postgresql` is a
    // separate artifact since Flyway 10, without which Flyway refuses to touch Postgres at all.
    implementation("org.springframework.boot:spring-boot-flyway")
    implementation("org.flywaydb:flyway-core")
    runtimeOnly("org.flywaydb:flyway-database-postgresql")
    developmentOnly("org.springframework.boot:spring-boot-devtools")
    runtimeOnly("org.postgresql:postgresql")
    testImplementation("org.springframework.boot:spring-boot-testcontainers")
    testImplementation(platform("org.testcontainers:testcontainers-bom:2.0.5"))
    testImplementation("org.testcontainers:testcontainers-junit-jupiter")
    testImplementation("org.testcontainers:testcontainers-postgresql")
    testImplementation("org.springframework.boot:spring-boot-starter-data-jpa-test")
    testImplementation("org.springframework.boot:spring-boot-starter-security-test")
    testImplementation("org.springframework.boot:spring-boot-starter-webmvc-test")
    testImplementation("org.springframework.boot:spring-boot-starter-websocket-test")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit5")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin {
    compilerOptions {
        freeCompilerArgs.addAll("-Xjsr305=strict", "-Xannotation-default-target=param-property")
    }
}

hibernate {
    enhancement {
    }
}

allOpen {
    annotation("jakarta.persistence.Entity")
    annotation("jakarta.persistence.MappedSuperclass")
    annotation("jakarta.persistence.Embeddable")
}

tasks.withType<Test> {
    useJUnitPlatform()
}

/**
 * The mock host: a development tool that dials into this backend and reports invented agents,
 * telemetry, chat and incidents, so the interface can be worked on without a Minecraft account, a
 * server, or the real host.
 *
 * Its own source set rather than a file in `main` or `test`. It shares the wire protocol types with
 * the application deliberately — renaming a command breaks its compilation instead of letting the
 * two drift apart — while staying off the application's classpath, so it cannot reach the published
 * image, and out of `test`, so it never runs in CI.
 *
 *     OSMIUM_HOST_TOKEN=osm_host_1_… ./gradlew mockHost
 */
sourceSets {
    create("mockhost") {
        // Classes, deliberately **not** `output`: that includes the processed resources, which makes
        // this task depend on `processResources` and `bootBuildInfo`. Those rewrite `build/`, and
        // devtools tears down a running `bootRun` the moment it does — so starting the mock host
        // killed the backend it had just connected to. It needs none of those resources anyway.
        compileClasspath += sourceSets["main"].output.classesDirs
        runtimeClasspath += sourceSets["main"].output.classesDirs
    }
}

configurations["mockhostImplementation"].extendsFrom(configurations["implementation"])
configurations["mockhostRuntimeOnly"].extendsFrom(configurations["runtimeOnly"])

tasks.register<JavaExec>("mockHost") {
    group = "application"
    description = "Runs a fake host reporting invented agents, telemetry, chat and incidents."
    mainClass = "net.integr.osmium.mockhost.MockHostKt"
    classpath = sourceSets["mockhost"].runtimeClasspath
    // Its whole job is saying what it sent and received.
    standardOutput = System.out
}
