package com.jensenyao.stripe.orbit;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.hipparchus.geometry.euclidean.threed.Vector3D;
import org.hipparchus.ode.nonstiff.DormandPrince853Integrator;
import org.msgpack.jackson.dataformat.MessagePackFactory;
import org.orekit.bodies.CelestialBodyFactory;
import org.orekit.bodies.GeodeticPoint;
import org.orekit.bodies.OneAxisEllipsoid;
import org.orekit.data.DataContext;
import org.orekit.data.DataSource;
import org.orekit.data.DirectoryCrawler;
import org.orekit.files.ccsds.ndm.ParserBuilder;
import org.orekit.files.ccsds.ndm.odm.oem.Oem;
import org.orekit.files.ccsds.ndm.odm.omm.Omm;
import org.orekit.files.sp3.SP3;
import org.orekit.files.sp3.SP3Parser;
import org.orekit.forces.gravity.HolmesFeatherstoneAttractionModel;
import org.orekit.forces.gravity.ThirdBodyAttraction;
import org.orekit.forces.gravity.potential.GravityFieldFactory;
import org.orekit.forces.drag.DragForce;
import org.orekit.forces.drag.IsotropicDrag;
import org.orekit.forces.radiation.IsotropicRadiationSingleCoefficient;
import org.orekit.forces.radiation.SolarRadiationPressure;
import org.orekit.frames.Frame;
import org.orekit.frames.FramesFactory;
import org.orekit.frames.TopocentricFrame;
import org.orekit.models.earth.atmosphere.NRLMSISE00;
import org.orekit.models.earth.atmosphere.data.CssiSpaceWeatherData;
import org.orekit.orbits.CartesianOrbit;
import org.orekit.orbits.KeplerianOrbit;
import org.orekit.orbits.Orbit;
import org.orekit.orbits.OrbitType;
import org.orekit.orbits.PositionAngleType;
import org.orekit.propagation.Propagator;
import org.orekit.propagation.SpacecraftState;
import org.orekit.propagation.ToleranceProvider;
import org.orekit.propagation.analytical.KeplerianPropagator;
import org.orekit.propagation.analytical.tle.TLE;
import org.orekit.propagation.analytical.tle.TLEPropagator;
import org.orekit.propagation.events.ElevationDetector;
import org.orekit.propagation.events.EventsLogger;
import org.orekit.propagation.events.handlers.ContinueOnEvent;
import org.orekit.propagation.numerical.NumericalPropagator;
import org.orekit.time.AbsoluteDate;
import org.orekit.time.TimeScale;
import org.orekit.time.TimeScalesFactory;
import org.orekit.utils.Constants;
import org.orekit.utils.IERSConventions;
import org.orekit.utils.PVCoordinates;
import org.orekit.utils.TimeStampedPVCoordinates;
import org.orekit.utils.Version;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.File;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public final class Main {
    private static final ObjectMapper MAPPER = new ObjectMapper(new MessagePackFactory());
    private static final DataInputStream INPUT = new DataInputStream(System.in);
    private static final DataOutputStream OUTPUT = new DataOutputStream(System.out);
    private static final ExecutorService EXECUTOR = Executors.newFixedThreadPool(Math.max(2, Runtime.getRuntime().availableProcessors() - 1));
    private static final Map<String, Future<?>> JOBS = new ConcurrentHashMap<>();
    private static final TimeScale UTC;
    private static final Frame EARTH_FRAME;
    private static final OneAxisEllipsoid EARTH;

    static {
        try {
            String dataPath = System.getProperty("orekit.data.path", "data");
            File scienceData = new File(System.getProperty("stripe.science.data", "science-data"));
            if (scienceData.isDirectory()) DataContext.getDefault().getDataProvidersManager().addProvider(new DirectoryCrawler(scienceData));
            DataContext.getDefault().getDataProvidersManager().addProvider(new DirectoryCrawler(new File(dataPath)));
            UTC = TimeScalesFactory.getUTC();
            EARTH_FRAME = FramesFactory.getITRF(IERSConventions.IERS_2010, true);
            EARTH = new OneAxisEllipsoid(Constants.WGS84_EARTH_EQUATORIAL_RADIUS, Constants.WGS84_EARTH_FLATTENING, EARTH_FRAME);
        } catch (Exception exception) {
            throw new ExceptionInInitializerError(exception);
        }
    }

    private Main() {}

    public static void main(String[] args) throws Exception {
        while (true) {
            try {
                int length = INPUT.readInt();
                byte[] payload = INPUT.readNBytes(length);
                if (payload.length != length) break;
                JsonNode request = MAPPER.readTree(payload);
                String requestId = request.path("requestId").asText();
                String command = request.path("command").asText();
                if ("job/cancel".equals(command)) {
                    String target = request.path("payload").path("requestId").asText();
                    Future<?> future = JOBS.remove(target);
                    if (future != null) future.cancel(true);
                    ObjectNode response = success(requestId);
                    response.putObject("result").put("cancelled", future != null);
                    write(response);
                    continue;
                }
                Future<?> future = EXECUTOR.submit(() -> process(requestId, command, request.path("payload")));
                JOBS.put(requestId, future);
            } catch (EOFException eof) {
                break;
            }
        }
        EXECUTOR.shutdownNow();
    }

    private static void process(String requestId, String command, JsonNode payload) {
        try {
            ObjectNode response = success(requestId);
            switch (command) {
                case "health" -> {
                    ObjectNode result = response.putObject("result");
                    result.put("engine", "Orekit");
                    result.put("version", Version.getVersion());
                    result.put("dataReady", true);
                }
                case "orbit/propagate" -> response.set("result", propagate(payload));
                case "access/compute" -> response.set("result", computeAccess(payload));
                case "coverage/compute" -> response.set("result", MAPPER.createObjectNode().put("supported", false).put("message", "覆盖网格由桌面并行分析器计算"));
                case "task/validate" -> {
                    ObjectNode result = MAPPER.createObjectNode();
                    result.put("valid", true);
                    result.putArray("conflicts");
                    response.set("result", result);
                }
                default -> throw new IllegalArgumentException("未知命令: " + command);
            }
            write(response);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            write(error(requestId, "任务已取消"));
        } catch (Exception exception) {
            write(error(requestId, exception.getClass().getSimpleName() + ": " + exception.getMessage()));
        } finally {
            JOBS.remove(requestId);
        }
    }

    private static ObjectNode propagate(JsonNode payload) throws Exception {
        JsonNode spacecraft = payload.path("spacecraft");
        JsonNode scenario = payload.path("scenario");
        Propagator propagator = buildPropagator(spacecraft);
        AbsoluteDate start = parseDate(scenario.path("startTime").asText());
        AbsoluteDate end = parseDate(scenario.path("endTime").asText());
        double step = Math.max(1.0, scenario.path("sampleStepSeconds").asDouble(30));
        ArrayNode samples = MAPPER.createArrayNode();
        for (AbsoluteDate date = start; date.compareTo(end) <= 0; date = date.shiftedBy(step)) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
            samples.add(sampleState(propagator.propagate(date)));
        }
        if (samples.isEmpty() || parseDate(samples.get(samples.size() - 1).path("time").asText()).compareTo(end) < 0) {
            samples.add(sampleState(propagator.propagate(end)));
        }
        ObjectNode result = MAPPER.createObjectNode();
        result.put("engine", "Orekit " + Version.getVersion());
        result.set("samples", samples);
        ArrayNode warnings = result.putArray("warnings");
        if ("tle".equals(spacecraft.path("orbit").path("type").asText()) && !"fast".equals(spacecraft.path("profile").asText())) {
            warnings.add("TLE 仍按 SGP4/SDP4 传播；改变数值积分配置不会提高 TLE 本身精度");
        }
        return result;
    }

    private static ObjectNode computeAccess(JsonNode payload) throws Exception {
        JsonNode spacecraft = payload.path("spacecraft");
        JsonNode scenario = payload.path("scenario");
        AbsoluteDate start = parseDate(scenario.path("startTime").asText());
        AbsoluteDate end = parseDate(scenario.path("endTime").asText());
        double maxOffNadir = payload.path("sensor").path("maxOffNadirDeg").asDouble(90.0);
        ArrayNode windows = MAPPER.createArrayNode();
        for (JsonNode asset : payload.path("groundAssets")) {
            if (!asset.path("visible").asBoolean(true)) continue;
            Propagator propagator = buildPropagator(spacecraft);
            JsonNode location = asset.path("location");
            GeodeticPoint point = new GeodeticPoint(Math.toRadians(location.path("lat").asDouble()), Math.toRadians(location.path("lon").asDouble()), location.path("heightKm").asDouble(0) * 1000);
            TopocentricFrame topocentric = new TopocentricFrame(EARTH, point, asset.path("name").asText());
            double minimum = Math.toRadians(asset.path("minElevationDeg").asDouble(10));
            boolean visibleAtStart = elevation(propagator.propagate(start), topocentric) >= minimum;
            EventsLogger logger = new EventsLogger();
            ElevationDetector detector = new ElevationDetector(60.0, 1.0e-3, topocentric).withConstantElevation(minimum).withHandler(new ContinueOnEvent());
            propagator.addEventDetector(logger.monitorDetector(detector));
            propagator.propagate(start, end);
            AbsoluteDate activeStart = visibleAtStart ? start : null;
            for (EventsLogger.LoggedEvent event : logger.getLoggedEvents()) {
                if (event.isIncreasing()) activeStart = event.getState().getDate();
                else if (activeStart != null) {
                    windows.add(accessWindow(spacecraft.path("id").asText(), asset.path("id").asText(), activeStart, event.getState().getDate(), buildPropagator(spacecraft), topocentric, maxOffNadir));
                    activeStart = null;
                }
            }
            if (activeStart != null) windows.add(accessWindow(spacecraft.path("id").asText(), asset.path("id").asText(), activeStart, end, buildPropagator(spacecraft), topocentric, maxOffNadir));
        }
        ObjectNode result = MAPPER.createObjectNode();
        result.set("windows", windows);
        return result;
    }

    private static ObjectNode accessWindow(String spacecraftId, String targetId, AbsoluteDate start, AbsoluteDate end, Propagator propagator, TopocentricFrame topocentric, double maxOffNadirDeg) throws Exception {
        double duration = end.durationFrom(start);
        double maxElevation = -Math.PI / 2;
        double azimuth = 0;
        double range = 0;
        double offNadir = 180;
        int count = Math.max(8, Math.min(120, (int) Math.ceil(duration / 10)));
        for (int index = 0; index <= count; index++) {
            AbsoluteDate date = start.shiftedBy(duration * index / count);
            SpacecraftState state = propagator.propagate(date);
            double nextElevation = elevation(state, topocentric);
            if (nextElevation > maxElevation) {
                maxElevation = nextElevation;
                Vector3D position = state.getPosition();
                azimuth = topocentric.getAzimuth(position, state.getFrame(), date);
                range = topocentric.getRange(position, state.getFrame(), date);
                Vector3D satelliteEcef = state.getPVCoordinates(EARTH_FRAME).getPosition();
                Vector3D groundEcef = EARTH.transform(topocentric.getPoint());
                offNadir = Math.toDegrees(Vector3D.angle(satelliteEcef.negate(), groundEcef.subtract(satelliteEcef)));
            }
        }
        ObjectNode window = MAPPER.createObjectNode();
        window.put("id", "access-" + spacecraftId + "-" + targetId + "-" + start.toString(UTC));
        window.put("spacecraftId", spacecraftId);
        window.put("targetId", targetId);
        window.put("startTime", start.toString(UTC));
        window.put("endTime", end.toString(UTC));
        window.put("durationSeconds", duration);
        window.put("maxElevationDeg", Math.toDegrees(maxElevation));
        window.put("azimuthDeg", Math.toDegrees(azimuth));
        window.put("rangeKm", range / 1000);
        window.put("sensorConstrained", offNadir <= maxOffNadirDeg);
        window.put("offNadirDeg", offNadir);
        return window;
    }

    private static double elevation(SpacecraftState state, TopocentricFrame topocentric) {
        return topocentric.getElevation(state.getPosition(), state.getFrame(), state.getDate());
    }

    private static Propagator buildPropagator(JsonNode spacecraft) throws Exception {
        JsonNode source = spacecraft.path("orbit");
        String type = source.path("type").asText();
        if ("tle".equals(type)) return TLEPropagator.selectExtrapolator(new TLE(source.path("line1").asText(), source.path("line2").asText()));
        if ("omm".equals(type)) {
            Omm omm = new ParserBuilder().buildOmmParser().parseMessage(new DataSource(Path.of(source.path("localPath").asText()).toFile()));
            return TLEPropagator.selectExtrapolator(omm.generateTLE());
        }
        if ("oem".equals(type)) {
            Oem oem = new ParserBuilder().buildOemParser().parseMessage(new DataSource(Path.of(source.path("localPath").asText()).toFile()));
            return oem.getSatellites().values().iterator().next().getPropagator();
        }
        if ("sp3".equals(type)) {
            SP3 sp3 = new SP3Parser().parse(new DataSource(Path.of(source.path("localPath").asText()).toFile()));
            return sp3.getSatellites().values().iterator().next().getPropagator();
        }
        Orbit orbit = "cartesian".equals(type) ? cartesianOrbit(source) : keplerianOrbit(source);
        String profile = spacecraft.path("profile").asText("fast");
        if ("fast".equals(profile)) return new KeplerianPropagator(orbit);
        return numericalPropagator(orbit, spacecraft, profile);
    }

    private static Orbit keplerianOrbit(JsonNode source) {
        Frame frame = "EME2000".equals(source.path("frame").asText()) ? FramesFactory.getEME2000() : FramesFactory.getGCRF();
        PositionAngleType angleType = "mean".equals(source.path("anomalyType").asText()) ? PositionAngleType.MEAN : PositionAngleType.TRUE;
        return new KeplerianOrbit(
            source.path("semiMajorAxisKm").asDouble() * 1000,
            source.path("eccentricity").asDouble(), Math.toRadians(source.path("inclinationDeg").asDouble()),
            Math.toRadians(source.path("argumentOfPerigeeDeg").asDouble()), Math.toRadians(source.path("raanDeg").asDouble()),
            Math.toRadians(source.path("anomalyDeg").asDouble()), angleType, frame, parseDate(source.path("epoch").asText()), Constants.WGS84_EARTH_MU
        );
    }

    private static Orbit cartesianOrbit(JsonNode source) {
        Frame frame = switch (source.path("frame").asText()) {
            case "ITRF" -> EARTH_FRAME;
            case "EME2000" -> FramesFactory.getEME2000();
            default -> FramesFactory.getGCRF();
        };
        JsonNode position = source.path("positionKm");
        JsonNode velocity = source.path("velocityKmS");
        AbsoluteDate date = parseDate(source.path("epoch").asText());
        TimeStampedPVCoordinates coordinates = new TimeStampedPVCoordinates(date,
            new Vector3D(position.get(0).asDouble() * 1000, position.get(1).asDouble() * 1000, position.get(2).asDouble() * 1000),
            new Vector3D(velocity.get(0).asDouble() * 1000, velocity.get(1).asDouble() * 1000, velocity.get(2).asDouble() * 1000));
        return new CartesianOrbit(coordinates, frame, Constants.WGS84_EARTH_MU);
    }

    private static Propagator numericalPropagator(Orbit orbit, JsonNode spacecraft, String profile) {
        double[][] tolerances = ToleranceProvider.getDefaultToleranceProvider(1.0).getTolerances(orbit, OrbitType.CARTESIAN);
        DormandPrince853Integrator integrator = new DormandPrince853Integrator(0.05, 300.0, tolerances[0], tolerances[1]);
        NumericalPropagator propagator = new NumericalPropagator(integrator);
        propagator.setOrbitType(OrbitType.CARTESIAN);
        propagator.setInitialState(new SpacecraftState(orbit, spacecraft.path("physical").path("massKg").asDouble(1000)));
        int degree = "research".equals(profile) ? 70 : 20;
        try {
            propagator.addForceModel(new HolmesFeatherstoneAttractionModel(EARTH_FRAME, GravityFieldFactory.getNormalizedProvider(degree, degree)));
        } catch (Exception unavailable) {
            propagator.addForceModel(new org.orekit.forces.gravity.NewtonianAttraction(Constants.WGS84_EARTH_MU));
        }
        propagator.addForceModel(new ThirdBodyAttraction(CelestialBodyFactory.getSun()));
        propagator.addForceModel(new ThirdBodyAttraction(CelestialBodyFactory.getMoon()));
        JsonNode physical = spacecraft.path("physical");
        try {
            CssiSpaceWeatherData weather = new CssiSpaceWeatherData(CssiSpaceWeatherData.DEFAULT_SUPPORTED_NAMES);
            NRLMSISE00 atmosphere = new NRLMSISE00(weather, CelestialBodyFactory.getSun(), EARTH);
            propagator.addForceModel(new DragForce(atmosphere, new IsotropicDrag(physical.path("dragAreaM2").asDouble(1.0), physical.path("dragCoefficient").asDouble(2.2))));
        } catch (Exception ignored) {
            // Propagation remains available when the current space-weather dataset has gaps.
        }
        try {
            IsotropicRadiationSingleCoefficient radiation = new IsotropicRadiationSingleCoefficient(physical.path("srpAreaM2").asDouble(1.0), physical.path("reflectivityCoefficient").asDouble(1.3));
            propagator.addForceModel(new SolarRadiationPressure(CelestialBodyFactory.getSun(), EARTH, radiation));
        } catch (Exception ignored) {
            // The remaining force models still provide a valid planning trajectory.
        }
        return propagator;
    }

    private static ObjectNode sampleState(SpacecraftState state) {
        PVCoordinates pv = state.getPVCoordinates();
        GeodeticPoint point = EARTH.transform(pv.getPosition(), state.getFrame(), state.getDate());
        ObjectNode sample = MAPPER.createObjectNode();
        sample.put("time", state.getDate().toString(UTC));
        sample.put("lon", Math.toDegrees(point.getLongitude()));
        sample.put("lat", Math.toDegrees(point.getLatitude()));
        sample.put("heightKm", point.getAltitude() / 1000);
        sample.put("speedKmS", pv.getVelocity().getNorm() / 1000);
        sample.set("positionKm", vector(pv.getPosition(), 0.001));
        sample.set("velocityKmS", vector(pv.getVelocity(), 0.001));
        return sample;
    }

    private static ArrayNode vector(Vector3D vector, double scale) {
        ArrayNode values = MAPPER.createArrayNode();
        values.add(vector.getX() * scale).add(vector.getY() * scale).add(vector.getZ() * scale);
        return values;
    }

    private static AbsoluteDate parseDate(String value) {
        return new AbsoluteDate(value, UTC);
    }

    private static ObjectNode success(String requestId) {
        ObjectNode response = MAPPER.createObjectNode();
        response.put("requestId", requestId);
        response.put("ok", true);
        response.put("progress", 1.0);
        return response;
    }

    private static ObjectNode error(String requestId, String message) {
        ObjectNode response = MAPPER.createObjectNode();
        response.put("requestId", requestId);
        response.put("ok", false);
        response.put("error", message == null ? "未知错误" : message);
        response.put("progress", 1.0);
        return response;
    }

    private static void write(ObjectNode response) {
        synchronized (OUTPUT) {
            try {
                byte[] bytes = MAPPER.writeValueAsBytes(response);
                OUTPUT.writeInt(bytes.length);
                OUTPUT.write(bytes);
                OUTPUT.flush();
            } catch (Exception exception) {
                exception.printStackTrace(System.err);
            }
        }
    }
}
