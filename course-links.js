// Links from schedule tasks to the matching lesson on the LMS
// (learn.taai.live). Keyed batch -> subject -> exact task_text, so the task
// text itself (which task_progress is keyed on) never has to change.
// Each link opens the lesson whose TITLE the task names first ("Lec 6" ->
// the lesson titled "Lecture 6", not the 6th item: exercises/animations
// sit between lectures in the syllabus).
//
// Built 2026-10-02 from the public Linear Algebra syllabus at
// https://learn.taai.live/learn/GATE-2027/Linear-Algebra--Mathematics-
// (Learnyst's ShowProductSyllabus response: section + lesson ids). Lesson
// URL shape: /learn/home/GATE-2027/<course-seo>/section/<sectionId>/lesson/<lessonId>.
// If a schedule is reloaded with different task wording, update the keys
// here too or that task simply shows as plain text again.
window.SCHEDULE_TASK_LINKS = {
  D: {
    'Linear Algebra': {
      // Basics of Linear Algebra & System of linear Equations / Lecture 1
      "Mod 1: Lec 1 to 5": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/605683/lesson/3783559',
      // Basics of Linear Algebra & System of linear Equations / Lecture 6
      "Mod 1: Lec 6 to 10 (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/605683/lesson/3783695',
      // Matrix Algebra / Basics of Matrix Algebra
      "Mod 2: All 6 Lessons (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/606888/lesson/3791650',
      // Vector Space / Basics
      "Mod 3: Basics to Prac 1": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/610876/lesson/3817485',
      // Vector Space / Four Fundamental Subspaces
      "Mod 3: Subspaces to dim (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/610876/lesson/3826411',
      // Determinant / Lecture 1
      "Mod 4 (Det) & Mod 5: Lec 1-2": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/617118/lesson/3865493',
      // Projection / Lecture 3
      "Mod 5: Proj Lec 3-5 (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/617121/lesson/3866230',
      // Eigen Value and Eigen Vector / Basics
      "Mod 6: Eigen Basics to Diag": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/618712/lesson/3868530',
      // Eigen Value and Eigen Vector / Rank vs Eigen values
      "Mod 6: Rank to Prac 2": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/618712/lesson/3886019',
      // Eigen Value and Eigen Vector / Similar matrices
      "Mod 6: Similar to Pos Def (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/618712/lesson/3892215',
      // SVD / Introduction to SVD - I
      "Mod 7: SVD Intro to Examples": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/622425/lesson/3892954',
      // SVD / Imp Properties on SVD
      "Mod 7: Imp Prop to HW 2": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/622425/lesson/3895896',
      // SVD / Vector and Matrix Norms
      "Mod 7: Norms to Low Rank (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/622425/lesson/4909102',
      // Remaining Concepts / Partition Matrix and Quadratic Form -I
      "Mod 8: Remaining Concepts (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/628630/lesson/3938600',
    },
  },
};
