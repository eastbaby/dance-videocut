import sys
import json
import math
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
from identity_tracking import associate, center, position_distance


def person(x, identity=0):
    # Deliberately contradictory appearance fields: position matching ignores them.
    return dict(x=x, y=10, w=40, h=100, appearance=[[identity, 1-identity]], confidence=.9)


class PositionTrackingTests(unittest.TestCase):
    def test_parallel_movement_ignores_lighting_changes(self):
        frames = [[person(i*3, i % 2), person(100+i*3)] for i in range(25)]
        boxes, lost = associate(frames, 0, person(0))
        self.assertEqual([b['x'] for b in boxes], [i*3 for i in range(25)])
        self.assertEqual(lost, [])

    def test_one_frame_dropout_holds_then_recovers(self):
        frames = [[person(0)], [person(80)], [person(9), person(82)]]
        boxes, lost = associate(frames, 0, person(0))
        self.assertEqual([b['x'] for b in boxes], [0, 0, 9])
        self.assertEqual(lost, [1])

    def test_three_frame_dropout_recovers_without_chasing_neighbour(self):
        frames = [[person(0)], [person(80)], [], [person(82)], [person(27), person(84)]]
        boxes, lost = associate(frames, 0, person(0))
        self.assertEqual([b['x'] for b in boxes], [0, 0, 0, 0, 27])
        self.assertEqual(lost, [1, 2, 3])

    def test_long_loss_does_not_expand_radius_or_adopt_late_bystander(self):
        frames = [[person(0)]] + [[person(100)]]*8 + [[person(1)]]
        boxes, lost = associate(frames, 0, person(0))
        self.assertTrue(all(b['x'] == 0 for b in boxes))
        self.assertEqual(lost, list(range(1, 10)))
        # Explicit re-lock can resume after that timeout.
        relocked, _ = associate(frames, 9, person(1))
        self.assertEqual(relocked[9]['x'], 1)

    def test_grace_period_is_about_100ms_at_60fps(self):
        frames = [[person(0)]] + [[]]*6 + [[person(15)]]
        boxes, lost = associate(frames, 0, person(0), 60)
        self.assertEqual(boxes[-1]['x'], 15)
        self.assertEqual(len(lost), 6)

    def test_near_tie_holds(self):
        boxes, lost = associate([[person(0)], [person(2), person(-2)]], 0, person(0))
        self.assertEqual(boxes[1]['x'], 0)
        self.assertEqual(lost, [1])

    def test_backward_association_uses_same_dropout_guard(self):
        frames = [[person(9), person(82)], [person(80)], [person(0)]]
        boxes, lost = associate(frames, 2, person(0))
        self.assertEqual([b['x'] for b in boxes], [9, 0, 0])
        self.assertEqual(lost, [1])

    def test_empty_seed_fails_instead_of_selecting_someone_else(self):
        with self.assertRaisesRegex(ValueError, '未检测到人物'):
            associate([[person(500)]], 0, person(0))

    def test_six_frame_real_dropout_recovers_instead_of_freezing(self):
        f = json.loads((Path(__file__).parent/'fixtures/six-frame-dropout.json').read_text())
        boxes, lost = associate(f['detections'], 0, f['seed'], f['fps'])
        self.assertEqual(lost, list(range(3, 9)))
        self.assertEqual(boxes[8], boxes[2])
        self.assertAlmostEqual(boxes[9]['x'], 1215.5, delta=2)
        self.assertNotEqual(boxes[-1], boxes[2])

    def test_recovery_requires_continuing_candidate(self):
        frames = [[person(0)]] + [[]]*6 + [[person(10)], [], []]
        boxes, lost = associate(frames, 0, person(0))
        self.assertEqual(boxes[-1]['x'], 0)
        self.assertIn(7, lost)

    def test_recovery_after_half_second_still_needs_manual_lock(self):
        frames = [[person(0)]] + [[]]*20 + [[person(1)]]*5
        boxes, _ = associate(frames, 0, person(0))
        self.assertTrue(all(b['x'] == 0 for b in boxes))

    def test_joint_motion_ignores_box_change_and_a_few_swinging_limbs(self):
        a = person(0); b = person(100)
        a['keypoints'] = [[i, i*2, .9] for i in range(17)]
        b['keypoints'] = [[i+3, i*2+4, .9] for i in range(17)]
        for i in range(4):
            b['keypoints'][i][0] += 100
        self.assertAlmostEqual(position_distance(a, b), 5)
        neighbour = person(1)
        neighbour['keypoints'] = [[i+100, i*2+100, .9] for i in range(17)]
        boxes, lost = associate([[a], [b, neighbour]], 0, a)
        self.assertEqual(boxes[1]['x'], 100)
        self.assertEqual(lost, [])

    def test_real_crouch_resumes_and_stays_with_front_person(self):
        f = json.loads((Path(__file__).parent/'fixtures/pose-crouch.json').read_text())
        boxes, lost = associate(f['detections'], 0, f['seed'], f['fps'])
        self.assertLess(len(lost), 20)
        # Front dancer at the end, not the smaller rear dancer near x=1300.
        self.assertLess(boxes[-1]['x'], 1200)
        self.assertGreater(boxes[-1]['h'], 600)
        self.assertNotEqual(boxes[-1], boxes[20])

    def test_real_detector_dropout_regression(self):
        f=json.loads((Path(__file__).parent/'fixtures/detection-dropout.json').read_text())
        frames=f['detections']; boxes,lost=associate(frames,0,f['seed'],f['fps'])
        # Exact original failure: frame 737 offered only distant people.
        self.assertEqual(lost, [3])
        self.assertEqual(boxes[3], boxes[2])
        previous=frames[2][2]
        neighbour=min(frames[3],key=lambda d: math.dist(center(d),center(previous)))
        self.assertGreater(math.dist(center(neighbour),center(previous)),440)
        self.assertLess(math.dist(center(boxes[4]),center(previous)),24)
        self.assertGreater(boxes[4]['x'],1400)

if __name__ == '__main__':
    unittest.main()
